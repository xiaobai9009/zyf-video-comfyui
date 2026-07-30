import asyncio
import subprocess
import shutil
import os
import re
import json
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import torch

from PIL import Image

from folder_paths import base_path

"""
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):

"""

_AUDIO_STREAM_PROBE_CACHE = {}

def __zyf_ffmpeg_suitability(path):
    try:
        version = subprocess.run([path, "-version"], check=True,
                                 capture_output=True).stdout.decode("utf-8")
    except:
        return 0
    score = 0
    #rough layout of the importance of various features
    simple_criterion = [("libvpx", 20),("264",10), ("265",3),
                        ("svtav1",5),("libopus", 1)]
    for criterion in simple_criterion:
        if version.find(criterion[0]) >= 0:
            score += criterion[1]
    #obtain rough compile year from copyright information
    copyright_index = version.find('2000-2')
    if copyright_index >= 0:
        copyright_year = version[copyright_index+6:copyright_index+9]
        if copyright_year.isnumeric():
            score += int(copyright_year)
    return score

def zyf_get_audio(file, start_time=0, duration=0):
    if ffmpeg_path is None:
        return b""
    args = [ffmpeg_path, "-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-vn"]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    try:
        return subprocess.run(args + ["-f", "wav", "-"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="ignore") if e.stderr else ""
        stdout = e.stdout.decode("utf-8", errors="ignore") if e.stdout else ""
        combined = (stderr + "\n" + stdout).strip()
        if _zyf_is_no_audio_error(combined):
            return b""
        raise
    except OSError:
        return b""

def zyf_lazy_eval(func):
    class Cache:
        def __init__(self, func):
            self.res = None
            self.func = func
        def get(self):
            if self.res is None:
                self.res = self.func()
            return self.res
    cache = Cache(func)
    return lambda : cache.get()

def _zyf_probe_audio_stream_params(file):
    cached = _AUDIO_STREAM_PROBE_CACHE.get(file)
    if cached is not None:
        return cached

    ffprobe_cmd = shutil.which("ffprobe")
    if ffprobe_cmd is None and ffmpeg_path is not None:
        ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        ffprobe_candidate = os.path.join(os.path.dirname(ffmpeg_path), ffprobe_name)
        if os.path.exists(ffprobe_candidate):
            ffprobe_cmd = ffprobe_candidate

    if ffprobe_cmd is None:
        _AUDIO_STREAM_PROBE_CACHE[file] = (None, None)
        return (None, None)

    cmd = [
        ffprobe_cmd,
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels",
        "-of", "json",
        file,
    ]
    try:
        process = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        data = json.loads(process.stdout) if process.stdout else {}
        stream = (data.get("streams") or [None])[0]
        if not isinstance(stream, dict):
            _AUDIO_STREAM_PROBE_CACHE[file] = (None, None)
            return (None, None)
        sample_rate_raw = stream.get("sample_rate")
        channels_raw = stream.get("channels")
        sample_rate = int(sample_rate_raw) if str(sample_rate_raw).isdigit() else None
        channels = int(channels_raw) if isinstance(channels_raw, int) else None
        _AUDIO_STREAM_PROBE_CACHE[file] = (sample_rate, channels)
        return (sample_rate, channels)
    except Exception:
        _AUDIO_STREAM_PROBE_CACHE[file] = (None, None)
        return (None, None)

def _zyf_get_audio(file, start_time=0, duration=0):
    if ffmpeg_path is None:
        return zyf_empty_audio_dict()
    args = [ffmpeg_path, "-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-vn"]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    try:
        #TODO: scan for sample rate and maintain
        res =  subprocess.run(args + ["-f", "f32le", "-"],
                              capture_output=True, check=True)
        stderr_text = res.stderr.decode("utf-8", errors="ignore")
        raw_audio = res.stdout or b""
        if len(raw_audio) == 0:
            return zyf_empty_audio_dict()
        # f32le must be 4-byte aligned; truncate trailing partial bytes defensively.
        remainder = len(raw_audio) % 4
        if remainder:
            raw_audio = raw_audio[: len(raw_audio) - remainder]
        if len(raw_audio) == 0:
            return zyf_empty_audio_dict()
        audio = torch.frombuffer(bytearray(raw_audio), dtype=torch.float32)
        if audio.numel() == 0:
            return zyf_empty_audio_dict()
        match = re.search(', (\\d+) Hz, (\\w+), ', stderr_text)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="ignore") if e.stderr else ""
        stdout = e.stdout.decode("utf-8", errors="ignore") if e.stdout else ""
        combined = (stderr + "\n" + stdout).strip()
        if _zyf_is_no_audio_error(combined):
            return zyf_empty_audio_dict()
        raise Exception(f"VHS failed to extract audio from {file}:\n" \
                + (combined or stderr))
    except OSError:
        return zyf_empty_audio_dict()
    if match:
        ar = int(match.group(1))
        # NOTE: Just throwing an error for other channel types right now
        # Will deal with issues if they come
        ac = {"mono": 1, "stereo": 2}.get(match.group(2), 2)
    else:
        probed_ar, probed_ac = _zyf_probe_audio_stream_params(file)
        ar = probed_ar if probed_ar and probed_ar > 0 else 44100
        ac = probed_ac if probed_ac and probed_ac > 0 else 2
    if ac <= 0:
        ac = 2
    usable_values = (audio.numel() // ac) * ac
    if usable_values <= 0:
        return zyf_empty_audio_dict(ar)
    if usable_values != audio.numel():
        audio = audio[:usable_values]
    audio = audio.reshape((-1,ac)).transpose(0,1).unsqueeze(0)
    return {'waveform': audio, 'sample_rate': ar}

def zyf_empty_audio_dict(sample_rate=44100):
    return {'waveform': torch.zeros((1, 1, 0), dtype=torch.float32), 'sample_rate': sample_rate}

def _zyf_is_no_audio_error(stderr):
    if not stderr:
        return False
    text = stderr.lower()
    return ("audio" not in text and "video" in text) \
        or "matches no streams" in text \
        or "no audio" in text \
        or "does not contain any stream" in text \
        or "output file does not contain any stream" in text \
        or ("error opening output file" in text and "pipe:" in text)

class ZyfLazyAudioMap(Mapping):
    def __init__(self, file, start_time, duration):
        self.file = file
        self.start_time=start_time
        self.duration=duration
        self._dict=None
    def __getitem__(self, key):
        if self._dict is None:
            try:
                self._dict = _zyf_get_audio(self.file, self.start_time, self.duration)
            except Exception:
                self._dict = zyf_empty_audio_dict()
        return self._dict[key]
    def __iter__(self):
        if self._dict is None:
            try:
                self._dict = _zyf_get_audio(self.file, self.start_time, self.duration)
            except Exception:
                self._dict = zyf_empty_audio_dict()
        return iter(self._dict)
    def __len__(self):
        if self._dict is None:
            try:
                self._dict = _zyf_get_audio(self.file, self.start_time, self.duration)
            except Exception:
                self._dict = zyf_empty_audio_dict()
        return len(self._dict)

def zyf_lazy_get_audio(file, start_time=0, duration=0):
    return ZyfLazyAudioMap(file, start_time, duration)


def zyf_cv_frame_generator_by_indices(video, frame_indices):
    """
    Yield frames from `video` at the specific 1-based frame indices in `frame_indices`.

    Used to perform forced-frame-rate "抽帧" extraction: given a list of original
    video frame numbers (computed by remapping in/out/currentFrame from a forced
    timeline back to the original video), read each one in order.

    Uses fast CAP_PROP_POS_FRAMES seek to a position slightly before the first
    needed frame (SEEK_MARGIN frames back to cover keyframe gaps), then reads
    sequentially. This avoids the O(N²) slowdown when processing segments where
    frame indices grow large.

    Yields a tuple (width, height, frame_duration_seconds) first, then each
    frame as an RGB float32 numpy array. The frame_duration reflects the
    *original* video frame rate (so callers can use it for audio trimming).
    """
    if not frame_indices:
        return
    try:
        normalized = [int(max(1, idx)) for idx in frame_indices]
        video_cap = cv2.VideoCapture(video)
        if not video_cap.isOpened():
            raise ValueError(f"{video} could not be loaded with cv.")
        cap_total = int(video_cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if cap_total > 0:
            normalized = [min(idx, cap_total) for idx in normalized]
        wanted_set = set(normalized)
        first_target = min(normalized)
        last_target = max(normalized)
        width = int(video_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(video_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = video_cap.get(cv2.CAP_PROP_FPS)
        base_frame_time = 1 / fps if fps and fps > 0 else 0
        try:
            yield (width, height, base_frame_time)
        except GeneratorExit:
            video_cap.release()
            raise

        # Fast seek to SEEK_MARGIN frames before the first needed frame.
        # CAP_PROP_POS_FRAMES seeks to the nearest keyframe (which may be
        # before our target), so we leave a margin, then read sequentially
        # from there. This is dramatically faster than reading from frame 1.
        SEEK_MARGIN = 60
        seek_to = max(1, first_target - SEEK_MARGIN)
        if seek_to > 1:
            video_cap.set(cv2.CAP_PROP_POS_FRAMES, seek_to - 1)  # 0-based
            start_read = seek_to
        else:
            start_read = 1

        prev_frame = None
        cache = {}
        # Sequential read from seek position to last_target.
        for orig_idx in range(start_read, last_target + 1):
            ok, frame = video_cap.read()
            if not ok or frame is None:
                break
            if orig_idx in wanted_set:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                cache[orig_idx] = np.array(rgb, dtype=np.float32) / 255.0
                if len(cache) == len(wanted_set):
                    break

        for orig_idx in normalized:
            frame = cache.get(orig_idx)
            if frame is None:
                continue
            if prev_frame is not None:
                inp = yield prev_frame
                if inp is not None:
                    return
            prev_frame = frame
        if prev_frame is not None:
            yield prev_frame
    finally:
        try:
            video_cap.release()
        except Exception:
            pass

def zyf_cv_frame_generator(video, number_of_frames_to_process, skip_first_frames, select_every_nth):
    try:
        video_cap = cv2.VideoCapture(video)
        if not video_cap.isOpened():
            raise ValueError(f"{video} could not be loaded with cv.")
        base_frame_time = 1/video_cap.get(cv2.CAP_PROP_FPS)
        width = video_cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        height = video_cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        prev_frame = None
        stride = max(1, int(select_every_nth or 1))
        target_frame_time = base_frame_time * stride

        # Fast seek: CAP_PROP_POS_FRAMES seeks to the nearest keyframe
        # (which may be before our target), then we grab() forward to
        # the exact frame. This avoids O(N²) for segmented processing.
        target_pos = int(skip_first_frames or 0)
        if target_pos > 0:
            SEEK_MARGIN = 60
            seek_pos = max(0, target_pos - SEEK_MARGIN)
            video_cap.set(cv2.CAP_PROP_POS_FRAMES, seek_pos)
            # Grab forward to reach exact target position.
            while True:
                cur_pos = int(video_cap.get(cv2.CAP_PROP_POS_FRAMES) or 0)
                if cur_pos >= target_pos:
                    break
                if not video_cap.grab():
                    break

        yield (int(width), int(height), target_frame_time)

        frames_added = 0
        frame_in_segment = 0

        while video_cap.isOpened():
            is_returned, frame_bgr = video_cap.read()
            if not is_returned or frame_bgr is None:
                break

            # Apply stride: only keep every Nth frame
            if frame_in_segment % stride != 0:
                frame_in_segment += 1
                continue
            frame_in_segment += 1

            frame = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            frame = np.array(frame, dtype=np.float32) / 255.0
            if prev_frame is not None:
                inp  = yield prev_frame
                if inp is not None:
                    return
            prev_frame = frame
            frames_added += 1
            if number_of_frames_to_process > 0 and frames_added >= number_of_frames_to_process:
                break
        if prev_frame is not None:
            yield prev_frame
    finally:
        video_cap.release()

def zyf_bislerp(samples, width, height):
    def slerp(b1, b2, r):
        '''slerps batches b1, b2 according to ratio r, batches should be flat e.g. NxC'''
        
        c = b1.shape[-1]

        #norms
        b1_norms = torch.norm(b1, dim=-1, keepdim=True)
        b2_norms = torch.norm(b2, dim=-1, keepdim=True)

        #normalize
        b1_normalized = b1 / b1_norms
        b2_normalized = b2 / b2_norms

        #zero when norms are zero
        b1_normalized[b1_norms.expand(-1,c) == 0.0] = 0.0
        b2_normalized[b2_norms.expand(-1,c) == 0.0] = 0.0

        #slerp
        dot = (b1_normalized*b2_normalized).sum(1)
        omega = torch.acos(dot)
        so = torch.sin(omega)

        #technically not mathematically correct, but more pleasing?
        res = (torch.sin((1.0-r.squeeze(1))*omega)/so).unsqueeze(1)*b1_normalized + (torch.sin(r.squeeze(1)*omega)/so).unsqueeze(1) * b2_normalized
        res *= (b1_norms * (1.0-r) + b2_norms * r).expand(-1,c)

        #edge cases for same or polar opposites
        res[dot > 1 - 1e-5] = b1[dot > 1 - 1e-5] 
        res[dot < 1e-5 - 1] = (b1 * (1.0-r) + b2 * r)[dot < 1e-5 - 1]
        return res
    
    def generate_bilinear_data(length_old, length_new, device):
        coords_1 = torch.arange(length_old, dtype=torch.float32, device=device).reshape((1,1,1,-1))
        coords_1 = torch.nn.functional.interpolate(coords_1, size=(1, length_new), mode="bilinear")
        ratios = coords_1 - coords_1.floor()
        coords_1 = coords_1.to(torch.int64)
        
        coords_2 = torch.arange(length_old, dtype=torch.float32, device=device).reshape((1,1,1,-1)) + 1
        coords_2[:,:,:,-1] -= 1
        coords_2 = torch.nn.functional.interpolate(coords_2, size=(1, length_new), mode="bilinear")
        coords_2 = coords_2.to(torch.int64)
        return ratios, coords_1, coords_2

    orig_dtype = samples.dtype
    samples = samples.float()
    n,c,h,w = samples.shape
    h_new, w_new = (height, width)
    
    #linear w
    ratios, coords_1, coords_2 = generate_bilinear_data(w, w_new, samples.device)
    coords_1 = coords_1.expand((n, c, h, -1))
    coords_2 = coords_2.expand((n, c, h, -1))
    ratios = ratios.expand((n, 1, h, -1))

    pass_1 = samples.gather(-1,coords_1).movedim(1, -1).reshape((-1,c))
    pass_2 = samples.gather(-1,coords_2).movedim(1, -1).reshape((-1,c))
    ratios = ratios.movedim(1, -1).reshape((-1,1))

    result = slerp(pass_1, pass_2, ratios)
    result = result.reshape(n, h, w_new, c).movedim(-1, 1)

    #linear h
    ratios, coords_1, coords_2 = generate_bilinear_data(h, h_new, samples.device)
    coords_1 = coords_1.reshape((1,1,-1,1)).expand((n, c, -1, w_new))
    coords_2 = coords_2.reshape((1,1,-1,1)).expand((n, c, -1, w_new))
    ratios = ratios.reshape((1,1,-1,1)).expand((n, 1, -1, w_new))

    pass_1 = result.gather(-2,coords_1).movedim(1, -1).reshape((-1,c))
    pass_2 = result.gather(-2,coords_2).movedim(1, -1).reshape((-1,c))
    ratios = ratios.movedim(1, -1).reshape((-1,1))

    result = slerp(pass_1, pass_2, ratios)
    result = result.reshape(n, h_new, w_new, c).movedim(-1, 1)
    return result.to(orig_dtype)

def zyf_lanczos(samples, width, height):
    images = [Image.fromarray(np.clip(255. * image.movedim(0, -1).cpu().numpy(), 0, 255).astype(np.uint8)) for image in samples]
    images = [image.resize((width, height), resample=Image.Resampling.LANCZOS) for image in images]
    images = [torch.from_numpy(np.array(image).astype(np.float32) / 255.0).movedim(-1, 0) for image in images]
    result = torch.stack(images)
    return result.to(samples.device, samples.dtype)

def zyf_common_upscale(samples, width, height, upscale_method, crop):
        if crop == "center":
            old_width = samples.shape[3]
            old_height = samples.shape[2]
            old_aspect = old_width / old_height
            new_aspect = width / height
            x = 0
            y = 0
            if old_aspect > new_aspect:
                x = round((old_width - old_width * (new_aspect / old_aspect)) / 2)
            elif old_aspect < new_aspect:
                y = round((old_height - old_height * (old_aspect / new_aspect)) / 2)
            s = samples[:,:,y:old_height-y,x:old_width-x]
        else:
            s = samples

        if upscale_method == "bislerp":
            return zyf_bislerp(s, width, height)
        elif upscale_method == "lanczos":
            return zyf_lanczos(s, width, height)
        else:
            return torch.nn.functional.interpolate(s, size=(height, width), mode=upscale_method)

def zyf_target_size(
    width: int,
    height: int,
    force_size: str,
    custom_short_edge: int = 512,
    custom_long_edge: int = 512,
    size_multiple: int = 0,
) -> tuple[int, int]:
    """Compute the target (width, height) after applying the force-size rule.

    Args:
        width: Source image width in pixels.
        height: Source image height in pixels.
        force_size: One of the ZyfVideoLoader force_size_options.
        custom_short_edge: Pixel value for the "自定义短边" rule.
        custom_long_edge: Pixel value for the "自定义长边" rule.
        size_multiple: If > 0, the output dimensions are rounded DOWN to
            the nearest multiple of this value (e.g. 8, 16, 32, 64).
            This is useful for latent-space compatibility (VAE encoders
            typically require dimensions divisible by 8 or 64).
            Set to 0 or a negative value to disable rounding.

    Returns:
        ``(target_width, target_height)`` — the computed dimensions.
    """
    if force_size == "自定义宽高":
        if custom_short_edge > 0 and custom_long_edge > 0:
            # Both specified: use directly as width × height.
            target_w = custom_short_edge
            target_h = custom_long_edge
        elif custom_short_edge > 0:
            # Width specified, height=0: scale proportionally by width.
            target_w = custom_short_edge
            target_h = max(1, (height * custom_short_edge) // width)
        elif custom_long_edge > 0:
            # Height specified, width=0: scale proportionally by height.
            target_h = custom_long_edge
            target_w = max(1, (width * custom_long_edge) // height)
        else:
            return (width, height)
    elif force_size == "自定义短边":
        if width < height:
            target_w = custom_short_edge
            target_h = max(1, (height * custom_short_edge) // width)
        else:
            target_h = custom_short_edge
            target_w = max(1, (width * custom_short_edge) // height)
    elif force_size == "自定义长边":
        if width < height:
            target_h = custom_long_edge
            target_w = max(1, (width * custom_long_edge) // height)
        else:
            target_w = custom_long_edge
            target_h = max(1, (height * custom_long_edge) // width)
    elif force_size == "Custom Height":
        if width < height:
            target_w = custom_short_edge
            target_h = max(1, (height * custom_short_edge) // width)
        else:
            target_h = custom_short_edge
            target_w = max(1, (width * custom_short_edge) // height)
    elif force_size == "Custom Width":
        if width < height:
            target_h = custom_long_edge
            target_w = max(1, (width * custom_long_edge) // height)
        else:
            target_w = custom_long_edge
            target_h = max(1, (height * custom_long_edge) // width)
    elif force_size not in ("禁用", "Disabled"):
        parts = force_size.split("x")
        if parts[0] == "?":
            target_w = (width * int(parts[1])) // height
            target_w = int(target_w) + 4 & ~7
            target_h = int(parts[1])
        elif parts[1] == "?":
            target_h = (height * int(parts[0])) // width
            target_h = int(target_h) + 4 & ~7
            target_w = int(parts[0])
        else:
            target_w = int(parts[0])
            target_h = int(parts[1])
    else:
        return (width, height)

    if size_multiple > 0:
        target_w = max(size_multiple, (target_w // size_multiple) * size_multiple)
        target_h = max(size_multiple, (target_h // size_multiple) * size_multiple)

    return (target_w, target_h)

# Dedicated single-worker executor for running asyncio.run() off the
# caller's thread. Reused across calls so we don't pay thread spawn
# overhead on every probe. Kept module-private; the executor itself
# is process-global.
_ASYNC_PROBE_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="zyf_async_probe",
)


def get_video_info(video_path):
    """Synchronous wrapper around :func:`get_video_info_async`.

    Safe to call from BOTH sync and async contexts:

    * Sync context (no running event loop) — runs the coroutine via
      :func:`asyncio.run` directly.
    * Async context (e.g. ComfyUI's prompt worker thread, which executes
      inside the aiohttp event loop) — :func:`asyncio.run` would raise
      ``RuntimeError: asyncio.run() cannot be called from a running
      event loop``. To avoid touching the caller's loop, we hand the
      coroutine to a dedicated worker thread and let ``asyncio.run``
      build a fresh, throwaway loop there.

    Returns ``(frame_rate, total_frames, duration, width, height)`` —
    identical contract to the async version.
    """
    coro = get_video_info_async(video_path)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running loop in this thread — safe to run inline.
        return asyncio.run(coro)
    # We ARE inside a running event loop (ComfyUI's prompt worker).
    # Run the coroutine on a dedicated worker thread with its own loop.
    return _ASYNC_PROBE_EXECUTOR.submit(asyncio.run, coro).result()


async def get_video_info_async(video_path):
    """Async variant of :func:`get_video_info`.

    The ffprobe call uses :func:`asyncio.create_subprocess_exec` so the
    ComfyUI aiohttp event loop stays responsive while ffprobe reads the
    file header. The cv2 fallback is fast (a metadata-only read on the
    order of milliseconds) but is still pushed onto a worker thread via
    :func:`asyncio.to_thread` so it does not block the loop either.

    Returns ``(frame_rate, total_frames, duration, width, height)`` —
    identical contract to the sync version.
    """
    full_video_path = video_path
    if not os.path.isabs(full_video_path) and not os.path.exists(full_video_path):
        full_video_path = os.path.join(base_path, video_path)
    if not os.path.exists(full_video_path):
        raise Exception(f"Video path does not exist: {full_video_path}")

    width = None
    height = None
    frame_rate = None
    total_frames = None
    duration = None

    ffprobe_cmd = shutil.which("ffprobe")
    if ffprobe_cmd is None and ffmpeg_path is not None:
        ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        ffprobe_candidate = os.path.join(os.path.dirname(ffmpeg_path), ffprobe_name)
        if os.path.exists(ffprobe_candidate):
            ffprobe_cmd = ffprobe_candidate

    if ffprobe_cmd is not None:
        # NOTE: do NOT pass `-count_frames` here. That flag tells ffprobe
        # to *decode every single frame* just to report the exact count,
        # which scales linearly with the video length — a 4-minute 30fps
        # clip (~7200 frames) blocks the ComfyUI server for ~15 seconds
        # while VHS-style loaders finish in 3-5 seconds. We rely on the
        # MP4/MKV container metadata (`nb_frames`) which ffprobe reads
        # from the file header in milliseconds. The fallback chain
        # below (`nb_frames` -> `duration * frame_rate`) covers any
        # edge cases where the container omits `nb_frames`.
        cmd = [
            ffprobe_cmd, '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration,width,height',
            '-show_entries', 'format=duration',
            '-of', 'json',
            full_video_path,
        ]
        # Use asyncio.create_subprocess_exec so the aiohttp event loop
        # can keep serving other requests while ffprobe reads the file
        # header. Equivalent semantics to the previous `subprocess.run`
        # call (text=True), but non-blocking.
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, _stderr_bytes = await process.communicate()
        stdout_text = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
        try:
            data = json.loads(stdout_text) if stdout_text else {}
        except json.JSONDecodeError:
            data = {}

        stream = None
        streams = data.get("streams") or []
        if streams:
            stream = streams[0]

        def _parse_rate(rate_value):
            if rate_value is None:
                return None
            if isinstance(rate_value, (int, float)):
                return float(rate_value)
            if isinstance(rate_value, str):
                if "/" in rate_value:
                    try:
                        num, den = map(float, rate_value.split("/", 1))
                        if den != 0:
                            return num / den
                    except ValueError:
                        return None
                try:
                    return float(rate_value)
                except ValueError:
                    return None
            return None

        if stream:
            frame_rate = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate"))
            # Without `-count_frames` `nb_read_frames` is always 0/N/A,
            # so this variable is effectively dead — but parsing it is
            # free and keeps the call site below identical in case the
            # flag is ever re-enabled behind an opt-in.
            nb_frames = stream.get("nb_frames")
            nb_read_frames = stream.get("nb_read_frames")
            stream_duration = stream.get("duration")
            stream_width = stream.get("width")
            stream_height = stream.get("height")

            def _parse_int(value):
                if isinstance(value, (int, float)):
                    return int(value)
                if isinstance(value, str) and value.isdigit():
                    return int(value)
                return None

            parsed_read = _parse_int(nb_read_frames)
            parsed_meta = _parse_int(nb_frames)
            if parsed_read is not None and parsed_read > 0:
                total_frames = parsed_read
            elif parsed_meta is not None and parsed_meta > 0:
                total_frames = parsed_meta
            if width is None:
                width = _parse_int(stream_width)
            if height is None:
                height = _parse_int(stream_height)

            try:
                if duration is None and stream_duration is not None:
                    duration = float(stream_duration)
            except ValueError:
                duration = None

        if duration is None:
            try:
                duration = float(data.get("format", {}).get("duration"))
            except (TypeError, ValueError):
                duration = None

        if total_frames is None and frame_rate and duration:
            total_frames = int(round(duration * frame_rate))

    def _cv2_fallback():
        """cv2 metadata read. Returned dict is merged into the local
        variables of the outer scope. Runs in a worker thread via
        ``asyncio.to_thread`` to keep the event loop responsive."""
        nonlocal frame_rate, total_frames, duration, width, height
        cap = cv2.VideoCapture(full_video_path)
        if not cap.isOpened():
            cap.release()
            return
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        cap_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if frame_rate is None and fps > 0:
            frame_rate = fps
        if total_frames is None and frame_count > 0:
            total_frames = int(frame_count)
        if duration is None and fps > 0 and frame_count > 0:
            duration = frame_count / fps
        if (width is None or width <= 0) and cap_width > 0:
            width = cap_width
        if (height is None or height <= 0) and cap_height > 0:
            height = cap_height

        if ffprobe_cmd is None:
            try:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                precise_count = 0
                while True:
                    ok = cap.grab()
                    if not ok:
                        break
                    precise_count += 1
                if precise_count > 0:
                    total_frames = int(precise_count)
                    if frame_rate and frame_rate > 0:
                        duration = total_frames / frame_rate
            except Exception:
                pass
        cap.release()

    if frame_rate is None or total_frames is None or duration is None or width is None or height is None:
        await asyncio.to_thread(_cv2_fallback)

    if frame_rate is None or frame_rate <= 0:
        frame_rate = 1.0
    if total_frames is None or total_frames <= 0:
        total_frames = 1
    if duration is None or duration <= 0:
        duration = total_frames / frame_rate
    if width is None or width <= 0:
        width = 0
    if height is None or height <= 0:
        height = 0

    return frame_rate, total_frames, duration, int(width), int(height)

ffmpeg_paths = []
try:
    from imageio_ffmpeg import get_ffmpeg_exe
    imageio_ffmpeg_path = get_ffmpeg_exe()
    ffmpeg_paths.append(imageio_ffmpeg_path)
except:
    print("Failed to import imageio_ffmpeg")
system_ffmpeg = shutil.which("ffmpeg")
if system_ffmpeg is not None:
    ffmpeg_paths.append(system_ffmpeg)

if len(ffmpeg_paths) == 0:
    print("No valid ffmpeg found.")
    ffmpeg_path = None
elif len(ffmpeg_paths) == 1:
    ffmpeg_path = ffmpeg_paths[0]
else:
    ffmpeg_path = max(ffmpeg_paths, key=__zyf_ffmpeg_suitability)
