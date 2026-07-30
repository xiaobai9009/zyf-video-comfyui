import folder_paths

import subprocess
import shutil
import os

import cv2
import numpy as np
import torch

from PIL import Image

"""
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):

"""

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
    args = [ffmpeg_path, "-v", "error", "-i", file]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    return subprocess.run(args + ["-f", "wav", "-"],
                          stdout=subprocess.PIPE, check=True).stdout


def _build_atempo_chain(factor):
    """Build an ffmpeg audio filter expression for time-stretching audio
    by `factor` (target_duration = factor * source_duration).

    We rely on `asetpts` rather than `atempo`. Some ffmpeg builds (notably
    recent Windows nightlies) silently ignore atempo stages, which would
    produce audio of the wrong length. asetpts always produces the correct
    duration at the cost of pitch shift (audio plays faster/slower to match
    the new duration). This trade-off is preferable to silent length
    mismatch on the user's machine.
    """
    if factor is None or abs(factor - 1.0) < 1e-3:
        return None
    if factor <= 0.0:
        return None
    return f"asetpts=PTS/{float(factor):.6f}"


def zyf_get_audio_atempo(file, start_time=0, duration=0, atempo_factor=1.0):
    """Like zyf_get_audio but applies an audio time-stretch filter
    (asetpts=PTS/atempo_factor) so the extracted audio matches the visual
    playback rate of the forced-fps output. atempo_factor = target_duration
    / source_duration.
    """
    af = _build_atempo_chain(atempo_factor)
    args = [ffmpeg_path, "-v", "error", "-i", file]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    if af is not None:
        args += ["-af", af]
    return subprocess.run(args + ["-f", "wav", "-"],
                          stdout=subprocess.PIPE, check=True).stdout

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

def zyf_cv_frame_generator(video, frame_load_cap, skip_first_frames, select_every_nth):
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

            # opencv loads images in BGR format, convert to RGB
            frame = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            frame = np.array(frame, dtype=np.float32) / 255.0
            if prev_frame is not None:
                inp  = yield prev_frame
                if inp is not None:
                    return
            prev_frame = frame
            frames_added += 1
            if frame_load_cap > 0 and frames_added >= frame_load_cap:
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
        # Scale so the shorter edge equals custom_short_edge, the
        # longer edge stays proportional.
        if width < height:
            target_w = custom_short_edge
            target_h = max(1, (height * custom_short_edge) // width)
        else:
            target_h = custom_short_edge
            target_w = max(1, (width * custom_short_edge) // height)
    elif force_size == "自定义长边":
        # Scale so the longer edge equals custom_long_edge, the
        # shorter edge stays proportional.
        if width < height:
            target_h = custom_long_edge
            target_w = max(1, (width * custom_long_edge) // height)
        else:
            target_w = custom_long_edge
            target_h = max(1, (height * custom_long_edge) // width)
    elif force_size == "Custom Height":
        # Legacy alias — kept for backward compatibility with old workflow
        # files.  Same as 自定义短边 in practice.
        if width < height:
            target_w = custom_short_edge
            target_h = max(1, (height * custom_short_edge) // width)
        else:
            target_h = custom_short_edge
            target_w = max(1, (width * custom_short_edge) // height)
    elif force_size == "Custom Width":
        # Legacy alias — kept for backward compatibility.
        if width < height:
            target_h = custom_long_edge
            target_w = max(1, (width * custom_long_edge) // height)
        else:
            target_w = custom_long_edge
            target_h = max(1, (height * custom_long_edge) // width)
    elif force_size not in ("禁用", "Disabled"):
        # Pattern-based options: "480x?", "?x480", "480x480", etc.
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

    # Apply size multiple rounding — snap dimensions down to the
    # nearest multiple so the output is compatible with VAE encoders.
    if size_multiple > 0:
        target_w = max(size_multiple, (target_w // size_multiple) * size_multiple)
        target_h = max(size_multiple, (target_h // size_multiple) * size_multiple)

    return (target_w, target_h)

def zyf_fix_path(video_path):
    annotated_path = os.path.join(folder_paths.base_path, video_path)
    if not os.path.exists(annotated_path):
        annotated_path = folder_paths.get_annotated_filepath(video_path)
    return annotated_path

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


def _probe_size_with_cv2(video_path):
    """Lightweight synchronous probe of the source video's native size.

    Uses cv2.VideoCapture which is fast and avoids any async-IO
    complications. Returns ``(width, height)`` or ``(0, 0)`` on failure.
    """
    try:
        cap = cv2.VideoCapture(str(video_path))
        try:
            if not cap.isOpened():
                return 0, 0
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            return w, h
        finally:
            cap.release()
    except Exception:
        return 0, 0


def zyf_ffmpeg_extract_frames(
    video_path,
    target_w=None,
    target_h=None,
    size_multiple=0,
    crop_x=0.0,
    crop_y=0.0,
    crop_w=1.0,
    crop_h=1.0,
    max_frames=None,
    start_frame=0,
    fps=None,
):
    """Extract frames from a video using ffmpeg, optionally cropping
    and scaling in the same pass.

    This is the fast path for the ZYF Frame Selector — it lets ffmpeg's
    libswscale do the resize (SIMD + multi-thread) instead of PIL's
    Lanczos, which is a huge win for 4K source videos.

    Uses double `-ss` seeking for fast AND accurate frame access when
    start_frame > 0: first `-ss` before `-i` does a fast keyframe seek,
    second `-ss` after `-i` does precise seeking over the short remaining
    distance (typically < 2 seconds of frames to decode). This avoids
    the O(N²) problem of decoding from frame 0 for every segment.

    Args:
        video_path: Input video file path.
        target_w / target_h: Target output dimensions. When provided,
            ffmpeg applies ``scale=`` with Lanczos. When None, no
            scaling is done.
        size_multiple: If > 0, output dimensions are rounded DOWN to the
            nearest multiple (e.g. 32). Handled by the scale expression.
        crop_x/y/w/h: Normalized crop box (0..1). Defaults to no crop.
        max_frames: Optional cap on the number of frames ffmpeg will
            output. Use this to limit output length.
        start_frame: 0-based frame index to start from. Uses fast
            keyframe seek when > 0 and fps is provided.
        fps: Source video FPS, required for fast seeking when start_frame > 0.

    Returns:
        ``imageBatch`` — a ``[N, H, W, 3]`` float32 tensor in 0..1 range.
    """
    if ffmpeg_path is None:
        raise RuntimeError("ffmpeg not available for zyf_ffmpeg_extract_frames")

    # Build crop filter (static, based on probed source dimensions).
    crop_filter = None
    has_crop = not (crop_x <= 0.0 and crop_y <= 0.0 and crop_w >= 0.999 and crop_h >= 0.999)
    if has_crop:
        src_w, src_h = _probe_size_with_cv2(video_path)
        if src_w <= 0 or src_h <= 0:
            src_w, src_h = 1, 1
        px = int(round(crop_x * src_w))
        py = int(round(crop_y * src_h))
        pw = max(1, int(round(crop_w * src_w)))
        ph = max(1, int(round(crop_h * src_h)))
        if px + pw > src_w:
            pw = src_w - px
        if py + ph > src_h:
            ph = src_h - py
        crop_filter = f"crop={pw}:{ph}:{px}:{py}"

    # Build scale filter.
    scale_filter = None
    if target_w and target_h:
        if size_multiple and size_multiple > 0:
            # Round DOWN to nearest multiple of N, then ensure even dims.
            w_expr = f"trunc({int(target_w)}/{int(size_multiple)})*{int(size_multiple)}"
            h_expr = f"trunc({int(target_h)}/{int(size_multiple)})*{int(size_multiple)}"
            w_expr = f"max({int(size_multiple)},floor({w_expr}/2)*2)"
            h_expr = f"max({int(size_multiple)},floor({h_expr}/2)*2)"
            scale_filter = f"scale={w_expr}:{h_expr}:flags=lanczos"
        else:
            # Make even dimensions (libx264/h264 yuv420p requires this).
            w_expr = f"floor({int(target_w)}/2)*2"
            h_expr = f"floor({int(target_h)}/2)*2"
            scale_filter = f"scale={w_expr}:{h_expr}:flags=lanczos"

    parts = []
    if crop_filter:
        parts.append(crop_filter)
    if scale_filter:
        parts.append(scale_filter)
    filter_str = ",".join(parts) if parts else None

    # Build the ffmpeg command. Use double -ss for fast+accurate seeking
    # when start_frame > 0: first -ss before -i does fast keyframe seek
    # (~3 sec before target), -copyts preserves original timestamps so
    # the second -ss after -i can precisely skip to the target time.
    # The decoder only needs to process ~3-5 sec from the keyframe to
    # target (instead of N*segment_length frames = O(N²) growth).
    cmd = [ffmpeg_path, "-v", "error"]
    use_fast_seek = bool(start_frame and start_frame > 0 and fps and fps > 0)
    if use_fast_seek:
        SEEK_MARGIN_SEC = 3.0  # fast-seek 3 seconds before target
        target_sec = float(start_frame) / float(fps)
        fast_seek_sec = max(0.0, target_sec - SEEK_MARGIN_SEC)
        cmd += ["-ss", f"{fast_seek_sec:.6f}"]
    cmd += ["-i", video_path]
    if use_fast_seek:
        cmd += ["-copyts", "-ss", f"{target_sec:.6f}"]
    if filter_str:
        cmd += ["-vf", filter_str]
    if max_frames and max_frames > 0:
        cmd += ["-frames:v", str(int(max_frames))]
    cmd += ["-f", "image2pipe", "-vcodec", "rawvideo", "-pix_fmt", "rgb24", "-"]

    # Run ffmpeg and capture raw RGB24 frames.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    raw, err = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg extract failed: {err.decode('utf-8', errors='replace')}"
        )

    # Determine the actual output frame size. When we asked for scale,
    # the output is at the target size; otherwise it's the source size.
    if target_w and target_h:
        out_w = int(target_w)
        out_h = int(target_h)
        if size_multiple and size_multiple > 0:
            sm = int(size_multiple)
            out_w = max(sm, (out_w // sm) * sm)
            out_h = max(sm, (out_h // sm) * sm)
        # Ensure even.
        out_w = max(2, (out_w // 2) * 2)
        out_h = max(2, (out_h // 2) * 2)
    else:
        out_w, out_h = _probe_size_with_cv2(video_path)
    if out_w <= 0 or out_h <= 0:
        raise RuntimeError("ffmpeg extract: invalid output frame size")

    frame_bytes = out_w * out_h * 3
    total_bytes = len(raw)
    n_frames = total_bytes // frame_bytes
    if n_frames == 0:
        raise RuntimeError("No frames generated by ffmpeg")

    arr = np.frombuffer(raw[: n_frames * frame_bytes], dtype=np.uint8).reshape(
        n_frames, out_h, out_w, 3
    )
    imageBatch = torch.from_numpy(arr.astype(np.float32) / 255.0)
    return imageBatch
