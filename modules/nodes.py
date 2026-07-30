import os
import shutil
import time
import uuid
import wave
import tempfile
from collections.abc import Mapping

import torch
import numpy as np
from PIL import Image
import torch.nn.functional as F
from .video_utils import *
from .zyf_pause_messaging import send_progress
from .utils import zyf_fix_path, zyf_get_audio_atempo, zyf_ffmpeg_extract_frames, ffmpeg_path as _zyf_ffmpeg_path

import folder_paths
import subprocess
import json

"""
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):

"""


# Threshold below which a Windows path is considered "short" and the
# `\\?\` extended-length prefix would only add noise. The MAX_PATH limit
# is 260; we use 240 as a safety margin so we don't rewrite paths that
# are clearly fine, and we don't risk other programs rejecting the
# `\\?\` form (some legacy code does not handle it).
_WIN_EXTENDED_PATH_THRESHOLD = 240


def _win_extended_path(path):
    r"""Return ``path`` with the Windows ``\\?\`` extended-length prefix
    when it would otherwise exceed ``MAX_PATH`` (260 chars).

    Background:
        Windows API calls that go through the legacy ``CreateFile`` /
        ``CreateProcess`` path are capped at 260 characters per path
        unless the caller opts into the extended-length form by
        prepending ``\\?\`` (drive paths) or ``\\?\UNC\`` (UNC paths).
        ComfyUI workflows frequently use deeply-nested filename
        prefixes like ``wan2.2/some_very_long_dataset_name/...`` and
        the resulting ``comfyui/output/...`` path can easily push past
        260. When that happens, ``subprocess.Popen`` (and ``open()``)
        raise ``FileNotFoundError: [WinError 206] 文件名或扩展名太长。``
        at the OS layer — the error surfaces from ``_execute_child``
        in ``subprocess.py`` before ffmpeg is even launched.

    Behavior:
        * Non-Windows or empty/relative paths — returned unchanged.
        * Paths shorter than 240 chars — returned unchanged (don't
          risk confusing downstream tools that don't understand the
          extended prefix).
        * Drive-lettered absolute paths (``C:\foo``) — returned as
          ``\\?\C:\foo``.
        * UNC paths (``\\server\share\foo``) — returned as
          ``\\?\UNC\server\share\foo`` per the Windows convention.
        * Already prefixed (``\\?\...``) — returned unchanged.

    The leading ``r`` on this docstring (and the doubled backslashes in
    the examples) is a Python convention to make the backslashes
    literal in the source — without it, ``\U`` would be parsed as a
    unicode escape and SyntaxError the whole file.
    """
    if not path or os.name != "nt":
        return path
    if path.startswith("\\\\?\\"):
        return path
    # Normalize separators — the \\?\ prefix only accepts backslashes
    # and forbids forward slashes in most positions.
    abs_path = path.replace("/", "\\")
    if len(abs_path) < _WIN_EXTENDED_PATH_THRESHOLD:
        return path
    if abs_path.startswith("\\\\"):
        # UNC: \\server\share\...  →  \\?\UNC\server\share\...
        return "\\\\?\\UNC\\" + abs_path.lstrip("\\")
    if len(abs_path) >= 2 and abs_path[1] == ":":
        # Drive letter: C:\...  →  \\?\C:\...
        return "\\\\?\\" + abs_path
    # Not a recognized absolute form (e.g. drive-relative or device
    # namespace) — don't force the prefix; let the caller see whatever
    # the OS would say about the malformed path.
    return path


def _next_lower_8n1(s, minimum=33):
    """返回 <= s 且 >= minimum 的最大 8N+1 值,找不到返回 None。"""
    if s < minimum:
        return None
    n = (s - 1) // 8
    while n >= 0:
        val = n * 8 + 1
        if val <= s and val >= minimum:
            return val
        n -= 1
    return None


def _compute_segment_sizes(total_frames, seg_len, min_last=33):
    """计算每段的帧数。

    规则:
      1. 起始按 ceil(total/seg_len) 切段,前 count-1 段为 seg_len,最后一段为剩余。
      2. 若最后一段 < min_last,向左侧(倒数第二、第三、...)段"借帧":
         被借的段降到 <= 原值且 >= min_last 的最大 8N+1 值(保持 8N+1 格式,
         WAN/LTX 模型兼容性要求),释放的帧数加到最后一段。
      3. 最后一段**不强制**保持 8N+1 格式,只需 >= min_last 即可,可以是任意整数
         (如 33/34/35/.../50/...)。这样可以精确吃掉剩余帧,避免无意义的尾部截断。
      4. 所有段帧数 <= seg_len,最后一段可能小于 seg_len(被借出帧后变小或被借入后变大)。

    帧数守恒: sum(sizes) == total_frames(借帧只是把帧数在段间重分配)。
    """
    if total_frames <= 0:
        return [0]
    if seg_len <= 0 or total_frames <= seg_len:
        return [total_frames]

    import math
    count = max(1, math.ceil(total_frames / seg_len))
    sizes = [seg_len] * (count - 1)
    sizes.append(total_frames - (count - 1) * seg_len)

    # 最后一段已经够长,无需借帧
    if sizes[-1] >= min_last:
        return sizes

    # 向前借帧:从倒数第二段开始向左,逐段降到下一个 8N+1 值(>= min_last),
    # 释放的帧数加到最后一段,直到最后一段 >= min_last。
    # 最后一段不要求 8N+1 格式,可以是任何 >= min_last 的整数。
    while sizes[-1] < min_last and len(sizes) > 1:
        borrowed = False
        for i in range(len(sizes) - 2, -1, -1):
            target = _next_lower_8n1(sizes[i] - 1, min_last)
            if target is None:
                continue
            give = sizes[i] - target
            if give <= 0:
                continue
            sizes[i] = target
            sizes[-1] += give
            borrowed = True
            break
        if not borrowed:
            break

    return sizes


def _safe_int(value, default):
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default

def _safe_float(value, default):
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default

def _extract_frame(images, index):
    """从图像批 [N, H, W, C] 中提取指定索引的单帧 [1, H, W, C]。

    用于 ZyfFrameInfoUnpack 节点输出首帧/尾帧图像。
    ``images`` 为 None 时返回 1×1 空白占位张量,避免下游节点
    因缺少输入而崩溃(与 ComfyUI 的 LoadImage 缺省行为一致)。
    """
    if images is None:
        return torch.zeros(1, 1, 1, 3)
    try:
        N = len(images)
    except TypeError:
        return torch.zeros(1, 1, 1, 3)
    if N == 0:
        return torch.zeros(1, 1, 1, 3)
    if index < 0:
        index = N + index
    index = max(0, min(N - 1, index))
    frame = images[index]
    # 确保形状为 [1, H, W, C]
    if frame.dim() == 3:
        frame = frame.unsqueeze(0)
    elif frame.dim() == 4:
        frame = frame[:1]
    return frame

def _normalize_force_size(force_size, allowed_values):
    """规范化 force_size 值。将旧版工作流中的 "Disabled" 兼容映射为 "禁用"。"""
    if force_size is None:
        return "禁用"
    value = str(force_size).strip()
    # 向后兼容:旧版工作流可能保存的是英文 "Disabled"
    if value == "Disabled":
        value = "禁用"
    if value in allowed_values:
        return value
    return "禁用"

# Freeform crop box is stored as four normalized 0.0-1.0 floats and
# applied to the output tensor. Clamp the values to the legal range
# and fall back to the "no crop" defaults (0, 0, 1, 1) when widgets
# are missing (old workflow files / pre-crop versions).
def _safe_normalize_crop(crop_x, crop_y, crop_w, crop_h):
    try:
        cx = float(crop_x) if crop_x is not None else 0.0
    except (TypeError, ValueError):
        cx = 0.0
    try:
        cy = float(crop_y) if crop_y is not None else 0.0
    except (TypeError, ValueError):
        cy = 0.0
    try:
        cw = float(crop_w) if crop_w is not None else 1.0
    except (TypeError, ValueError):
        cw = 1.0
    try:
        ch = float(crop_h) if crop_h is not None else 1.0
    except (TypeError, ValueError):
        ch = 1.0
    cx = max(0.0, min(1.0, cx))
    cy = max(0.0, min(1.0, cy))
    # Lower bound 0.02 matches the JS overlay's minimum crop size.
    cw = max(0.02, min(1.0, cw))
    ch = max(0.02, min(1.0, ch))
    # Make sure the box never spills outside [0, 1].
    if cx + cw > 1.0:
        cw = 1.0 - cx
    if cy + ch > 1.0:
        ch = 1.0 - cy
    if cw < 0.02:
        cw = 0.02
        if cx + cw > 1.0:
            cx = 1.0 - cw
    if ch < 0.02:
        ch = 0.02
        if cy + ch > 1.0:
            cy = 1.0 - ch
    return cx, cy, cw, ch

def _apply_freeform_crop(image_batch, crop_x, crop_y, crop_w, crop_h):
    """Slice an [N, H, W, C] tensor using the normalized crop box.

    Returns the input unchanged when the box is the full image
    (which is the common case when crop is not in use).
    """
    if image_batch is None:
        return image_batch
    try:
        if int(image_batch.shape[0]) <= 0:
            return image_batch
        H = int(image_batch.shape[1])
        W = int(image_batch.shape[2])
    except Exception:
        return image_batch
    cx, cy, cw, ch = _safe_normalize_crop(crop_x, crop_y, crop_w, crop_h)
    if cx <= 0.0 and cy <= 0.0 and cw >= 0.999 and ch >= 0.999:
        return image_batch
    # 2026-07-14: 修复裁剪后输出尺寸与前端展示不一致(off-by-one 1 像素)。
    #
    # 之前用:
    #   x0 = max(0, min(int(round(cx * W)), W - 1))
    #   x1 = max(x0 + 1, min(int(round((cx + cw) * W)), W))
    # 这里有两个独立来源的 1 像素误差:
    #   1) Python 的 round() 是 banker's rounding(偶数优先),与前端
    #      Math.round()(half-up)在 cx/cw 边界值(恰好是 .5)时相差 1 像素;
    #   2) 即使 round 一致,x1 - x0 与"用户看到的裁剪宽度"不一定相符。
    #      例如 W=833, cx=0, cw=1.0:
    #        旧 x0=0, x1=833, 裁剪宽度=833 → 后续 force-size 拉到 832
    #        时多 1 像素拉伸,前端标签写 832、实际 tensor 写 833。
    #      又如 W=832, cx=0, cw=0.999(拖框舍入误差):
    #        旧 x0=0, x1=int(round(831.168))=831, 裁剪宽度=831
    #        → 后续 force-size 拉到 832 时再多 1 像素拉伸。
    #
    # 新策略:让裁剪宽度严格等于 `int(cw * W + 0.5)`,与前端
    # `Math.round(cw * W)` 数学等价(half-up 而非 banker's rounding),
    # 且 x0/x1 通过"先定目标宽度,再决定起点"的方式保证 `x1 - x0`
    # 恒等于前端展示的裁剪宽度,杜绝 off-by-one。
    cropped_w = max(1, int(cw * W + 0.5))
    cropped_h = max(1, int(ch * H + 0.5))
    # x0 钳位:保证 x0 + cropped_w 不会超过 W(否则裁剪宽度被截断)
    x0 = max(0, min(int(cx * W + 0.5), W - cropped_w))
    y0 = max(0, min(int(cy * H + 0.5), H - cropped_h))
    x1 = x0 + cropped_w
    y1 = y0 + cropped_h
    if x1 <= x0 or y1 <= y0:
        return image_batch
    return image_batch[:, y0:y1, x0:x1, :]

def _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
    """True when force_size == "自定义宽高" AND both custom width/height
    are > 0. In that case the user explicitly wants exact output
    dimensions, but the system must NOT stretch the image; it should
    scale-to-cover and center-crop to match the target aspect ratio.
    """
    try:
        cw = int(custom_short_edge) if custom_short_edge is not None else 0
    except (TypeError, ValueError):
        cw = 0
    try:
        ch = int(custom_long_edge) if custom_long_edge is not None else 0
    except (TypeError, ValueError):
        ch = 0
    return force_size == "自定义宽高" and cw > 0 and ch > 0

def _compute_aspect_crop_normalized(src_w, src_h, target_w, target_h):
    """Return (cx, cy, cw, ch) — a normalized center-crop box that
    converts a ``(src_w, src_h)`` image into one with the same aspect
    ratio as ``(target_w, target_h)``.

    When the source aspect already matches the target aspect (within
    a small tolerance), the full image is returned (0, 0, 1, 1).
    """
    if src_w <= 0 or src_h <= 0 or target_w <= 0 or target_h <= 0:
        return (0.0, 0.0, 1.0, 1.0)
    target_ratio = target_w / target_h
    source_ratio = src_w / src_h
    if abs(target_ratio - source_ratio) < 1e-6:
        return (0.0, 0.0, 1.0, 1.0)
    if target_ratio < source_ratio:
        # Source is wider than target — reduce width via center crop.
        new_w = src_h * target_ratio
        cx = (src_w - new_w) / 2.0 / src_w
        return (cx, 0.0, new_w / src_w, 1.0)
    # Source is taller than target — reduce height via center crop.
    new_h = src_w / target_ratio
    cy = (src_h - new_h) / 2.0 / src_h
    return (0.0, cy, 1.0, new_h / src_h)

def _compute_combined_aspect_crop_box(
    src_w, src_h,
    user_cx, user_cy, user_cw, user_ch,
    target_w, target_h,
):
    """Return ``(cx, cy, cw, ch)`` — a single normalized crop box in
    ORIGINAL source coordinates that combines the user freeform crop
    with a center-crop to match the target aspect ratio.

    The order is: first apply the user crop, then center-crop the
    result to match ``(target_w, target_h)``. Both steps are merged
    into one box so the ffmpeg fast path can pass a single
    ``crop=W:H:X:Y`` expression to ffmpeg.
    """
    if src_w <= 0 or src_h <= 0 or target_w <= 0 or target_h <= 0:
        return (user_cx, user_cy, user_cw, user_ch)
    # Convert user crop to source pixels.
    ux0 = user_cx * src_w
    uy0 = user_cy * src_h
    uw_px = user_cw * src_w
    uh_px = user_ch * src_h
    if uw_px <= 0 or uh_px <= 0:
        return (user_cx, user_cy, user_cw, user_ch)
    target_ratio = target_w / target_h
    cropped_ratio = uw_px / uh_px
    if abs(target_ratio - cropped_ratio) < 1e-6:
        return (user_cx, user_cy, user_cw, user_ch)
    if target_ratio < cropped_ratio:
        # User-cropped image is wider than target — reduce width.
        new_w_px = uh_px * target_ratio
        ax0_in_cropped = (uw_px - new_w_px) / 2.0
        aw_in_cropped = new_w_px / uw_px
        return (
            (ux0 + ax0_in_cropped) / src_w,
            user_cy,
            (aw_in_cropped * uw_px) / src_w,
            user_ch,
        )
    # User-cropped image is taller than target — reduce height.
    new_h_px = uw_px / target_ratio
    ay0_in_cropped = (uh_px - new_h_px) / 2.0
    ah_in_cropped = new_h_px / uh_px
    return (
        user_cx,
        (uy0 + ay0_in_cropped) / src_h,
        user_cw,
        (ah_in_cropped * uh_px) / src_h,
    )

def _normalize_images(images):
    if images is None:
        return None
    if isinstance(images, dict):
        images = images.get("image") or images.get("images")
    return images

def _get_images_length(images):
    if images is None:
        return 0
    try:
        return int(images.shape[0])
    except Exception:
        try:
            return len(images)
        except Exception:
            return 0

def _get_images_cache_key(images, force_size, custom_short_edge, custom_long_edge, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, size_multiple=0):
    if images is None:
        return None
    # Normalize the crop box so the cache key is stable across
    # functionally-equivalent settings (e.g. (0, 0, 1, 1) == no crop).
    crop_x, crop_y, crop_w, crop_h = _safe_normalize_crop(crop_x, crop_y, crop_w, crop_h)
    try:
        shape = tuple(images.shape)
        dtype = str(images.dtype)
        device = str(images.device) if hasattr(images, "device") else "cpu"
        data_ptr = None
        try:
            data_ptr = images.untyped_storage().data_ptr()
        except Exception:
            try:
                data_ptr = images.storage().data_ptr()
            except Exception:
                data_ptr = None
        return ("tensor", data_ptr, shape, dtype, device, force_size, custom_short_edge, custom_long_edge, crop_x, crop_y, crop_w, crop_h, size_multiple)
    except Exception:
        return ("object", id(images), force_size, custom_short_edge, custom_long_edge, crop_x, crop_y, crop_w, crop_h, size_multiple)

def _get_preview_cache_key(images_key, preview_size):
    return ("preview", images_key, preview_size)

def _get_audio_cache_key(audio, total_duration):
    audio_dict = _normalize_audio_dict(audio)
    if not audio_dict:
        return None
    waveform = audio_dict.get("waveform")
    sample_rate = int(audio_dict.get("sample_rate") or 44100)
    try:
        if not isinstance(waveform, torch.Tensor):
            waveform = torch.as_tensor(waveform)
        data_ptr = None
        try:
            data_ptr = waveform.untyped_storage().data_ptr()
        except Exception:
            try:
                data_ptr = waveform.storage().data_ptr()
            except Exception:
                data_ptr = None
        shape = tuple(waveform.shape)
        return ("audio", data_ptr, shape, sample_rate, float(total_duration))
    except Exception:
        return ("audio_obj", id(audio), sample_rate, float(total_duration))

def _get_video_audio_cache_key(video_path, total_duration):
    if not video_path:
        return None
    return ("video_audio", str(video_path), float(total_duration))

def _sequence_frame_path(sequence, index):
    if not sequence:
        return None
    prefix = sequence.get("prefix")
    subfolder = sequence.get("subfolder", "")
    ext = sequence.get("ext", "png")
    pad = int(sequence.get("pad", 5))
    if not prefix:
        return None
    filename = f"{prefix}_{str(index).zfill(pad)}.{ext}"
    target_dir = os.path.join(folder_paths.get_temp_directory(), subfolder)
    return os.path.join(target_dir, filename)

def _save_audio_preview(audio, unique_id):
    audio_dict = _normalize_audio_dict(audio)
    if not audio_dict:
        return None
    sample_rate = int(audio_dict.get("sample_rate") or 44100)
    if sample_rate <= 0:
        sample_rate = 44100
    waveform = _ensure_waveform_tensor(audio_dict.get("waveform"))
    if waveform is None or waveform.numel() == 0:
        return None
    waveform = waveform.detach().cpu().float().squeeze(0)
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    waveform = torch.clamp(waveform, -1.0, 1.0)
    audio_np = (waveform * 32767.0).to(torch.int16).numpy()
    interleaved = audio_np.T.reshape(-1)

    temp_dir = folder_paths.get_temp_directory()
    subfolder = "zyf_frame_selector"
    target_dir = os.path.join(temp_dir, subfolder)
    _cleanup_temp_sequences(target_dir)
    os.makedirs(target_dir, exist_ok=True)
    timestamp = int(time.time() * 1000)
    filename = f"zyf_audio_{unique_id}_{timestamp}.wav"
    file_path = os.path.join(target_dir, filename)
    with wave.open(file_path, "wb") as wav:
        wav.setnchannels(audio_np.shape[0])
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(interleaved.tobytes())
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": "temp",
    }

def _resize_image_batch(images, force_size, custom_short_edge, custom_long_edge, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, size_multiple=0):
    """Apply crop FIRST, then force-size on the cropped result.

    The order matters: previously force-size was applied to the original
    image dimensions, and the crop was applied afterwards. This meant that
    the crop box was expressed in the *original* pixel space, and the
    force-size target was computed from the *original* dimensions. When
    the user wanted a specific output size after cropping, the math was
    non-obvious. Now the crop is applied first, so the force-size
    calculator sees the cropped dimensions as the source — matching the
    user's mental model of "crop to this region, then resize to that
    size".

    When ``force_size == "自定义宽高"`` with BOTH custom width/height > 0
    an additional aspect-preserving center-crop is inserted between
    the user crop and the upscale step. This prevents the image from
    being stretched to fit an exact (W, H) target — instead the system
    scales-to-cover and center-crops to the target aspect ratio before
    resizing to the exact target dimensions.
    """
    if images is None:
        return None
    # Crop first — the force-size step operates on the cropped result.
    images = _apply_freeform_crop(images, crop_x, crop_y, crop_w, crop_h)
    if force_size != "禁用":
        height = int(images.shape[1])
        width = int(images.shape[2])
        new_size = zyf_target_size(width, height, force_size, custom_short_edge, custom_long_edge, size_multiple)
        target_w = int(new_size[0])
        target_h = int(new_size[1])
        # Aspect-preserving center-crop BEFORE the upscale — avoids
        # stretching when "自定义宽高" specifies both W and H.
        if _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
            cx, cy, cw, ch = _compute_aspect_crop_normalized(width, height, target_w, target_h)
            if not (cx <= 0.0 and cy <= 0.0 and cw >= 0.999 and ch >= 0.999):
                images = _apply_freeform_crop(images, cx, cy, cw, ch)
                width = int(images.shape[2])
                height = int(images.shape[1])
        if target_w != width or target_h != height:
            s = images.movedim(-1, 1)
            s = zyf_common_upscale(s, new_size[0], new_size[1], "lanczos", "center")
            images = s.movedim(1, -1)
    return images

def _resize_image_batch_for_preview(images, preview_size):
    if images is None or preview_size is None:
        return images
    try:
        height = int(images.shape[1])
        width = int(images.shape[2])
    except Exception:
        return images
    max_dim = max(width, height)
    if max_dim <= preview_size:
        return images
    scale = preview_size / float(max_dim)
    new_width = max(1, int(round(width * scale)))
    new_height = max(1, int(round(height * scale)))
    s = images.movedim(-1, 1)
    s = zyf_common_upscale(s, new_width, new_height, "lanczos", "center")
    return s.movedim(1, -1)

def _save_image_sequence(images, unique_id, progress_callback=None):
    images = _normalize_images(images)
    if images is None:
        return None
    temp_dir = folder_paths.get_temp_directory()
    subfolder = "zyf_frame_selector"
    target_dir = os.path.join(temp_dir, subfolder)
    _cleanup_temp_sequences(target_dir)
    os.makedirs(target_dir, exist_ok=True)
    timestamp = int(time.time() * 1000)
    prefix = f"zyf_seq_{unique_id}_{timestamp}"
    pad = 5
    images_np = images.detach().cpu().numpy()
    if images_np.dtype != np.uint8:
        max_val = images_np.max() if images_np.size else 1.0
        if max_val <= 1.0:
            images_np = np.clip(images_np, 0.0, 1.0) * 255.0
        else:
            images_np = np.clip(images_np, 0.0, 255.0)
        images_np = images_np.astype(np.uint8)
    total_count = int(images_np.shape[0]) if images_np.ndim >= 1 else 0
    step = max(1, total_count // 20) if total_count else 1
    for idx, frame in enumerate(images_np, start=1):
        filename = f"{prefix}_{str(idx).zfill(pad)}.png"
        file_path = os.path.join(target_dir, filename)
        try:
            Image.fromarray(frame).save(file_path)
        except Exception:
            Image.fromarray(frame[:, :, :3]).save(file_path)
        if progress_callback and (idx == 1 or idx % step == 0 or idx == total_count):
            progress_callback(idx, total_count)
    return {
        "prefix": prefix,
        "count": total_count,
        "subfolder": subfolder,
        "type": "temp",
        "ext": "png",
        "pad": pad,
    }

def _cleanup_temp_sequences(target_dir, max_age_seconds=7200):
    if not os.path.isdir(target_dir):
        return
    now = time.time()
    try:
        for filename in os.listdir(target_dir):
            if not filename.startswith("zyf_seq_") or not filename.endswith(".png"):
                continue
            full_path = os.path.join(target_dir, filename)
            try:
                if now - os.path.getmtime(full_path) > max_age_seconds:
                    os.remove(full_path)
            except OSError:
                continue
    except OSError:
        return

def _empty_audio_dict(sample_rate=44100):
    return {
        "waveform": torch.zeros((1, 1, 0), dtype=torch.float32),
        "sample_rate": sample_rate,
    }

def _safe_audio_output_dict(audio, fallback_sample_rate=44100):
    """Normalize audio to a dict with ``waveform`` and ``sample_rate`` keys.

    When the input is empty or invalid, returns an audio dict with a
    **zero-sample waveform** (``numel() == 0``). This is the correct
    sentinel for "no audio" — downstream consumers (especially the
    Video Saver and its ``-shortest`` ffmpeg flag) rely on an empty
    waveform to detect that there is no audio track to mux.

    Previously this function returned a waveform with a single silent
    sample (``torch.zeros((1,1,1))``), which made the Video Saver
    believe audio was present, causing it to add ``-shortest`` to the
    ffmpeg command. With a 1-sample audio file, ``-shortest`` stopped
    encoding after 1/44100 s ≈ 0.02 ms, producing an empty output video.
    """
    audio_dict = _normalize_audio_dict(audio)
    if not audio_dict:
        return {
            "waveform": torch.zeros((1, 1, 0), dtype=torch.float32),
            "sample_rate": int(fallback_sample_rate) if fallback_sample_rate and fallback_sample_rate > 0 else 44100,
        }
    sample_rate = int(audio_dict.get("sample_rate") or fallback_sample_rate or 44100)
    if sample_rate <= 0:
        sample_rate = 44100
    waveform = _ensure_waveform_tensor(audio_dict.get("waveform"))
    if waveform is None or waveform.numel() == 0:
        return {
            "waveform": torch.zeros((1, 1, 0), dtype=torch.float32),
            "sample_rate": sample_rate,
        }
    return {
        "waveform": waveform,
        "sample_rate": sample_rate,
    }

def _empty_audio_bytes():
    return b""

def _normalize_audio_dict(audio):
    if audio is None:
        return None
    if isinstance(audio, Mapping):
        try:
            if "waveform" in audio:
                _ = audio.get("waveform") if hasattr(audio, "get") else audio["waveform"]
                return audio
        except Exception:
            return None
    return None

def _ensure_waveform_tensor(waveform):
    if waveform is None:
        return None
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform)
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.dim() == 2:
        waveform = waveform.unsqueeze(0)
    return waveform

def _pad_or_crop_waveform(waveform, target_samples):
    if waveform is None:
        return None
    current_samples = waveform.shape[-1]
    if target_samples < 0:
        target_samples = 0
    if current_samples == target_samples:
        return waveform
    if current_samples > target_samples:
        return waveform[..., :target_samples]
    pad_amount = target_samples - current_samples
    if pad_amount <= 0:
        return waveform
    pad = (0, pad_amount)
    return F.pad(waveform, pad)

def _align_audio_to_video(audio, total_duration, trim_start, trim_duration):
    audio_dict = _normalize_audio_dict(audio)
    if not audio_dict:
        return _empty_audio_dict()
    sample_rate = int(audio_dict.get("sample_rate") or 44100)
    if sample_rate <= 0:
        sample_rate = 44100
    waveform = _ensure_waveform_tensor(audio_dict.get("waveform"))
    if waveform is None:
        return _empty_audio_dict(sample_rate)
    if waveform.numel() == 0:
        return _empty_audio_dict(sample_rate)

    total_target = max(0.0, total_duration, trim_start + trim_duration)
    total_samples = int(round(total_target * sample_rate))
    waveform = _pad_or_crop_waveform(waveform, total_samples)

    start_samples = int(round(max(0.0, trim_start) * sample_rate))
    trim_samples = int(round(max(0.0, trim_duration) * sample_rate))
    end_samples = start_samples + trim_samples
    if end_samples > total_samples:
        waveform = _pad_or_crop_waveform(waveform, end_samples)
    if trim_samples <= 0:
        trimmed = waveform[..., 0:0]
    else:
        trimmed = waveform[..., start_samples:end_samples]
    return {"waveform": trimmed, "sample_rate": sample_rate}
def _ffmpeg_target_size(cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple):
    """Compute (target_w, target_h) for the ffmpeg -vf scale filter.

    Mirrors the zyf_target_size logic but returns the raw pixel dims
    that ffmpeg will scale to. The even-dim rounding + size_multiple
    rounding is done inside the ffmpeg scale expression.
    """
    if force_size == "禁用":
        return None, None
    new_size = zyf_target_size(cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple)
    target_w, target_h = new_size
    if target_w == cropped_w and target_h == cropped_h:
        return None, None
    return int(target_w), int(target_h)


def getImageBatch(full_video_path, number_of_frames_to_process, select_every_nth_frame, starting_frame, force_size, custom_short_edge, custom_long_edge, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, size_multiple=0):
    # ---- Fast ffmpeg path ----
    # Strategy: let ffmpeg do crop+scale in one pass via -vf, then do
    # the frame selection in Python (much cheaper than ffmpeg's
    # select='eq(n,0)+eq(n,1)+...' which is O(N²)). For 4K sources the
    # ffmpeg SIMD scale replaces the slow PIL Lanczos and the win is
    # significant.
    if _zyf_ffmpeg_path is not None:
        import time as _time
        _t0 = _time.time()
        # Get the source fps to compute target_frame_time later.
        # Use cv2.VideoCapture (fast, no async-IO issues) instead of
        # get_video_info (which uses ThreadPoolExecutor in async ctx).
        try:
            from .utils import _probe_size_with_cv2
            src_w, src_h = _probe_size_with_cv2(full_video_path)
            if src_w <= 0 or src_h <= 0:
                raise RuntimeError("cv2 probe returned 0 dimensions")
            # Get fps from cv2 as well — faster than get_video_info
            cap = cv2.VideoCapture(str(full_video_path))
            try:
                src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            finally:
                cap.release()
        except Exception as e:
            src_w = src_h = 0
            src_fps = 0.0
            print(f"[ZYF] ffmpeg fast path skipped: probe failed: {e}")
        if src_w > 0 and src_h > 0:
            _, _, _, _, cropped_w, cropped_h = _compute_crop_and_size(
                src_w, src_h, crop_x, crop_y, crop_w, crop_h
            )
            target_w, target_h = _ffmpeg_target_size(
                cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple
            )
            if target_w and target_h:
                # When "自定义宽高" specifies both W and H, the user
                # expects an aspect-preserving center-crop (not a
                # stretch). Combine the user freeform crop with the
                # aspect-crop into a single normalized box so ffmpeg
                # can apply it as one ``crop=W:H:X:Y`` expression.
                eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h = (
                    crop_x, crop_y, crop_w, crop_h,
                )
                if _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
                    eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h = _compute_combined_aspect_crop_box(
                        src_w, src_h, crop_x, crop_y, crop_w, crop_h, target_w, target_h,
                    )
                # Cap frames to decode: after fast seeking to starting_frame, we only
                # need to output enough frames to cover the selection range.
                # Add a small margin to handle any timestamp rounding issues.
                step = max(1, int(select_every_nth_frame or 1))
                if number_of_frames_to_process and number_of_frames_to_process > 0:
                    # After seek, output enough frames for stride selection + margin
                    max_frames = (number_of_frames_to_process - 1) * step + 1 + 30
                else:
                    max_frames = None
                try:
                    all_frames = zyf_ffmpeg_extract_frames(
                        full_video_path,
                        target_w=target_w,
                        target_h=target_h,
                        size_multiple=0,  # already rounded in target dims
                        crop_x=eff_crop_x, crop_y=eff_crop_y, crop_w=eff_crop_w, crop_h=eff_crop_h,
                        max_frames=max_frames,
                        start_frame=starting_frame,
                        fps=src_fps,
                    )
                    _t_extract = _time.time() - _t0
                    # After fast+precise seek, frame 0 IS at starting_frame.
                    # Apply stride selection from the beginning.
                    selected = all_frames[::step]
                    if number_of_frames_to_process and len(selected) > number_of_frames_to_process:
                        selected = selected[:number_of_frames_to_process]
                    target_frame_time = (1.0 / src_fps) * step if src_fps > 0 else None
                    print(f"[ZYF] ffmpeg fast path: {len(selected)} frames {target_w}x{target_h} in {_t_extract:.1f}s")
                    return (selected, target_frame_time)
                except Exception as e:
                    print(f"[ZYF] ffmpeg fast path failed, falling back to cv2+PIL: {e}")
        else:
            print(f"[ZYF] ffmpeg fast path skipped: force_size={force_size}, target=({target_w},{target_h})")

    # ---- Slow fallback path: cv2 + PIL Lanczos ----
    generatedImages = zyf_cv_frame_generator(full_video_path, number_of_frames_to_process, starting_frame, select_every_nth_frame)
    (width, height, target_frame_time) = next(generatedImages)
    width = int(width)
    height = int(height)

    imageBatch = torch.from_numpy(np.fromiter(generatedImages, np.dtype((np.float32, (height, width, 3)))))
    if len(imageBatch) == 0:
        raise RuntimeError("No frames generated")

    # Crop first, then force-size on the cropped result.
    imageBatch = _apply_freeform_crop(imageBatch, crop_x, crop_y, crop_w, crop_h)
    if force_size != "禁用":
        cropped_h = int(imageBatch.shape[1])
        cropped_w = int(imageBatch.shape[2])
        new_size = zyf_target_size(cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple)
        target_w = int(new_size[0])
        target_h = int(new_size[1])
        # Aspect-preserving center-crop BEFORE the upscale — avoids
        # stretching when "自定义宽高" specifies both W and H.
        if _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
            cx, cy, cw, ch = _compute_aspect_crop_normalized(cropped_w, cropped_h, target_w, target_h)
            if not (cx <= 0.0 and cy <= 0.0 and cw >= 0.999 and ch >= 0.999):
                imageBatch = _apply_freeform_crop(imageBatch, cx, cy, cw, ch)
                cropped_w = int(imageBatch.shape[2])
                cropped_h = int(imageBatch.shape[1])
        if target_w != cropped_w or target_h != cropped_h:
            s = imageBatch.movedim(-1,1)
            s = zyf_common_upscale(s, target_w, target_h, "lanczos", "center")
            imageBatch = s.movedim(1,-1)

    return (imageBatch, target_frame_time)


def _compute_crop_and_size(src_w, src_h, crop_x, crop_y, crop_w, crop_h):
    """Mirror of _safe_normalize_crop + pixel conversion. Returns
    ``(cx_px, cy_px, cw_px, ch_px, cropped_w, cropped_h)`` in pixels.
    """
    cx, cy, cw, ch = _safe_normalize_crop(crop_x, crop_y, crop_w, crop_h)
    if cx <= 0.0 and cy <= 0.0 and cw >= 0.999 and ch >= 0.999:
        cw_px = src_w
        ch_px = src_h
        cx_px = 0
        cy_px = 0
    else:
        x0 = max(0, min(int(round(cx * src_w)), src_w - 1))
        y0 = max(0, min(int(round(cy * src_h)), src_h - 1))
        x1 = max(x0 + 1, min(int(round((cx + cw) * src_w)), src_w))
        y1 = max(y0 + 1, min(int(round((cy + ch) * src_h)), src_h))
        cx_px, cy_px = x0, y0
        cw_px, ch_px = (x1 - x0), (y1 - y0)
    return cx_px, cy_px, cw_px, ch_px, cw_px, ch_px


def getImageBatchByIndices(full_video_path, frame_indices, force_size, custom_short_edge, custom_long_edge, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, size_multiple=0):
    """Extract specific 1-based frame indices from a video file (forced-fps抽帧)."""
    if not frame_indices:
        raise RuntimeError("getImageBatchByIndices: empty frame_indices")
    normalized_indices = [max(1, int(idx)) for idx in frame_indices]

    # ---- Fast ffmpeg path ----
    if _zyf_ffmpeg_path is not None:
        import time as _time
        _t0 = _time.time()
        try:
            from .utils import _probe_size_with_cv2
            src_w, src_h = _probe_size_with_cv2(full_video_path)
            if src_w <= 0 or src_h <= 0:
                raise RuntimeError("cv2 probe returned 0 dimensions")
            cap = cv2.VideoCapture(str(full_video_path))
            try:
                src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            finally:
                cap.release()
        except Exception as e:
            src_w = src_h = 0
            src_fps = 0.0
            print(f"[ZYF] ffmpeg fast path (by-indices) skipped: probe failed: {e}")
        if src_w > 0 and src_h > 0:
            _, _, _, _, cropped_w, cropped_h = _compute_crop_and_size(
                src_w, src_h, crop_x, crop_y, crop_w, crop_h
            )
            target_w, target_h = _ffmpeg_target_size(
                cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple
            )
            if target_w and target_h:
                # When "自定义宽高" specifies both W and H, the user
                # expects an aspect-preserving center-crop (not a
                # stretch). Combine the user freeform crop with the
                # aspect-crop into a single normalized box so ffmpeg
                # can apply it as one ``crop=W:H:X:Y`` expression.
                eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h = (
                    crop_x, crop_y, crop_w, crop_h,
                )
                if _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
                    eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h = _compute_combined_aspect_crop_box(
                        src_w, src_h, crop_x, crop_y, crop_w, crop_h, target_w, target_h,
                    )
                # For by-indices, fast-seek to just before the lowest requested index
                # then output enough frames to cover the highest index.
                min_idx_1based = min(normalized_indices) if normalized_indices else 1
                max_idx_1based = max(normalized_indices) if normalized_indices else None
                seek_start_0based = max(0, min_idx_1based - 1)
                if max_idx_1based is not None:
                    max_frames = (max_idx_1based - min_idx_1based + 1) + 30
                else:
                    max_frames = None
                try:
                    all_frames = zyf_ffmpeg_extract_frames(
                        full_video_path,
                        target_w=target_w,
                        target_h=target_h,
                        size_multiple=0,
                        crop_x=eff_crop_x, crop_y=eff_crop_y, crop_w=eff_crop_w, crop_h=eff_crop_h,
                        max_frames=max_frames,
                        start_frame=seek_start_0based,
                        fps=src_fps,
                    )
                    _t_extract = _time.time() - _t0
                    # Pick 1-based indices → 0-based offset within the seeked range.
                    picked = []
                    for idx in normalized_indices:
                        zero_based = idx - 1 - seek_start_0based
                        if 0 <= zero_based < len(all_frames):
                            picked.append(all_frames[zero_based])
                    if not picked:
                        raise RuntimeError("No frames in ffmpeg output matched requested indices")
                    imageBatch = torch.stack(picked, dim=0)
                    target_frame_time = (1.0 / src_fps) if src_fps > 0 else None
                    print(f"[ZYF] ffmpeg fast path (by-indices): {len(picked)} frames {target_w}x{target_h} in {_t_extract:.1f}s")
                    return (imageBatch, target_frame_time)
                except Exception as e:
                    print(f"[ZYF] ffmpeg fast path (by-indices) failed, falling back to cv2+PIL: {e}")

    # ---- Slow fallback path: cv2 + PIL Lanczos ----
    generatedImages = zyf_cv_frame_generator_by_indices(full_video_path, normalized_indices)
    (width, height, target_frame_time) = next(generatedImages)
    width = int(width)
    height = int(height)

    imageBatch = torch.from_numpy(np.fromiter(generatedImages, np.dtype((np.float32, (height, width, 3)))))
    if len(imageBatch) == 0:
        raise RuntimeError("No frames generated")

    # Crop first, then force-size on the cropped result.
    imageBatch = _apply_freeform_crop(imageBatch, crop_x, crop_y, crop_w, crop_h)
    if force_size != "禁用":
        cropped_h = int(imageBatch.shape[1])
        cropped_w = int(imageBatch.shape[2])
        new_size = zyf_target_size(cropped_w, cropped_h, force_size, custom_short_edge, custom_long_edge, size_multiple)
        target_w = int(new_size[0])
        target_h = int(new_size[1])
        # Aspect-preserving center-crop BEFORE the upscale — avoids
        # stretching when "自定义宽高" specifies both W and H.
        if _needs_aspect_preserving_crop(force_size, custom_short_edge, custom_long_edge):
            cx, cy, cw, ch = _compute_aspect_crop_normalized(cropped_w, cropped_h, target_w, target_h)
            if not (cx <= 0.0 and cy <= 0.0 and cw >= 0.999 and ch >= 0.999):
                imageBatch = _apply_freeform_crop(imageBatch, cx, cy, cw, ch)
                cropped_w = int(imageBatch.shape[2])
                cropped_h = int(imageBatch.shape[1])
        if target_w != cropped_w or target_h != cropped_h:
            s = imageBatch.movedim(-1,1)
            s = zyf_common_upscale(s, target_w, target_h, "lanczos", "center")
            imageBatch = s.movedim(1,-1)

    return (imageBatch, target_frame_time)

class ZyfVideoLoader():

    supported_video_extensions =  ['webm', 'mp4', 'mkv']
    force_size_options = [
        "禁用",
        "自定义短边",
        "自定义长边",
        "自定义宽高",
        "480x?",
        "?x480",
        "480x480",
        "832x?",
        "?x832",
        "832x832",
    ]
    # Size multiple options for the "图像尺寸倍数" widget.
    size_multiple_options = ["无", "8", "16", "32", "64", "128", "256", "512"]

    # ---- 分段计划自动索引缓存 ----
    # 持久化缓存: 记录每个分段计划的当前索引, 每次执行后自动递增。
    # 与 zyf_image_directory_nodes 的 auto_index 机制一致。
    _segment_auto_index = {}
    _segment_last_config = None

    @classmethod
    def _get_segment_cache_file(cls):
        import folder_paths
        cache_dir = os.path.join(folder_paths.base_path, "custom_nodes", "zyf-video", ".cache")
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except OSError:
            pass
        return os.path.join(cache_dir, "segment_auto_index.json")

    @classmethod
    def _load_segment_auto_index(cls):
        if cls._segment_auto_index:
            return
        cache_file = cls._get_segment_cache_file()
        try:
            if os.path.exists(cache_file):
                with open(cache_file, "r", encoding="utf-8") as f:
                    cls._segment_auto_index = json.load(f)
        except Exception as e:
            print(f"[ZYF] 加载分段自动索引缓存失败: {e}")
            cls._segment_auto_index = {}

    @classmethod
    def _save_segment_auto_index(cls):
        cache_file = cls._get_segment_cache_file()
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(cls._segment_auto_index, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[ZYF] 保存分段自动索引缓存失败: {e}")

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = []
        for root, _, filenames in os.walk(input_dir):
            for filename in filenames:
                file_parts = filename.rsplit(".", 1)
                if len(file_parts) <= 1:
                    continue
                if file_parts[-1].lower() not in ZyfVideoLoader.supported_video_extensions:
                    continue
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, input_dir).replace("\\", "/")
                files.append(rel_path)
        files = sorted(set(files))
        default_video_path = files[0] if files else ""
        return {
            "required": {
                "视频路径": ("STRING", {
                    "default": default_video_path,
                    "tooltip": "视频源文件路径(支持子文件夹,例如 'wan2.2/clip.mp4')。"
                               "也可以直接拖拽视频到节点输入框上传,或点节点上的上传按钮选择本地文件。",
                }),
                "强制尺寸": (ZyfVideoLoader.force_size_options, {
                    "tooltip": "把视频帧强制缩放到指定尺寸:\n"
                               "  - 禁用         : 保持原始尺寸\n"
                               "  - 自定义短边    : 按短边缩放,短边对齐目标值,长边等比\n"
                               "  - 自定义长边    : 按长边缩放,长边对齐目标值,短边等比\n"
                               "  - 自定义宽高    : 直接指定宽/高,填0则该边等比缩放(可能裁剪)\n"
                               "  - 480x? / ?x480 : 宽/高对齐 480,另一边等比\n"
                               "  - 832x? / ?x832 : 宽/高对齐 832,另一边等比\n"
                               "  - 480x480 / 832x832 : 固定正方形",
                }),
                "自定义短边": ("INT", {
                    "default": 480, "min": 0, "max": 8192, "step": 8,
                    "tooltip": "自定义短边目标值(像素)。仅当'强制尺寸'为'自定义短边'时生效。",
                }),
                "自定义长边": ("INT", {
                    "default": 832, "min": 0, "max": 8192, "step": 8,
                    "tooltip": "自定义长边目标值(像素)。仅当'强制尺寸'为'自定义长边'时生效。",
                }),
                "自定义宽度": ("INT", {
                    "default": 480, "min": 0, "max": 8192, "step": 8,
                    "tooltip": "自定义宽度目标值(像素)。仅当'强制尺寸'为'自定义宽高'时生效。\n"
                               "填 0 表示宽度等比(由高度决定),填 >0 且高度=0 则按宽度等比缩放。",
                }),
                "自定义高度": ("INT", {
                    "default": 832, "min": 0, "max": 8192, "step": 8,
                    "tooltip": "自定义高度目标值(像素)。仅当'强制尺寸'为'自定义宽高'时生效。\n"
                               "填 0 表示高度等比(由宽度决定),填 >0 且宽度=0 则按高度等比缩放。",
                }),
                "图像尺寸倍数": (ZyfVideoLoader.size_multiple_options, {
                    "default": "32",
                    "tooltip": "将输出尺寸向下取整到指定倍数。例如选 64,输出宽高将为 64 的整数倍。"
                               "选'无'则不取整。常用于 VAE 编码兼容性(需 8/64 的倍数)。",
                }),
                "强制帧率": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 60.0, "step": 0.1,
                    "tooltip": "强制把视频帧率重映射为 1-60 内的值(0 表示沿用原视频帧率)。\n"
                               "启用后按原视频时长 * 强制帧率 计算总帧数,从原始视频抽帧映射到新时间轴,音频时长自动同步。",
                }),
            },
            "optional": {
                "images": ("IMAGE", {
                    "tooltip": "可选的图像批输入(来自上游节点的 [N, H, W, C] 张量)。"
                               "连接后,'视频路径'会被自动隐藏,改用图像批作为帧源。",
                }),
                "audio": ("AUDIO", {
                    "tooltip": "可选的音频输入。连接后用此音频作为播放/输出音轨,不再读取视频自带音频。",
                }),
                "fps": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 240.0, "step": 0.1, "forceInput": True,
                    "tooltip": "可选外部帧率(由上游节点传入)。当 images 输入连接时,使用此 fps 代替'强制帧率'。",
                }),
                "graph_id": ("STRING", {
                    "default": "",
                    "tooltip": "内部用:用于把进度消息路由到前端正确的图实例,一般无需手动设置。",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "分段批次编号": ("INT", {
                    "default": 0, "min": 0, "max": 9999, "step": 1,
                    "tooltip": "分段计划自动索引的批次标识。修改此编号将重置自动索引。"
                               "同一批次编号共享自动索引,队列批量运行时每次自动递增。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "VHS_AUDIO", "ZYF_VIDEO_INFO",)
    RETURN_NAMES = ("当前图像", "视频帧(选中)", "音频", "视频信息",)
    OUTPUT_NODE = False
    CATEGORY = "zyf-video"
    FUNCTION = "process_video"

    def process_video(
        self,
        视频路径,
        强制尺寸,
        自定义短边,
        自定义长边,
        图像尺寸倍数="无",
        强制帧率=0.0,
        裁剪X=0.0,
        裁剪Y=0.0,
        裁剪W=1.0,
        裁剪H=1.0,
        images=None,
        audio=None,
        fps=None,
        graph_id=None,
        prompt=None,
        unique_id=None,
        自定义宽度=None,
        自定义高度=None,
        分段计划="禁用",
        分段长度=81,
        分段索引=0,
        分段批次编号=0,
    ):
        if 自定义短边 is None:
            自定义短边 = 480
        if 自定义长边 is None:
            自定义长边 = 832
        if 自定义宽度 is None:
            自定义宽度 = 480
        if 自定义高度 is None:
            自定义高度 = 832
        # When "自定义宽高" is selected, use the width/height pair as the
        # edge values. Otherwise use the short/long edge pair.
        force_size = _normalize_force_size(强制尺寸, ZyfVideoLoader.force_size_options)
        if force_size == "自定义宽高":
            _used_short = 自定义宽度
            _used_long = 自定义高度
        else:
            _used_short = 自定义短边
            _used_long = 自定义长边
        # Parse the size multiple: "无" → 0 (disabled), otherwise the int value.
        size_multiple = 0
        if 图像尺寸倍数 is not None and str(图像尺寸倍数).strip() != "无":
            try:
                size_multiple = int(图像尺寸倍数)
            except (ValueError, TypeError):
                size_multiple = 0
        prompt_inputs = {}
        if isinstance(prompt, dict):
            node_data = prompt.get(str(unique_id)) or prompt.get(unique_id) or {}
            if isinstance(node_data, dict):
                prompt_inputs = node_data.get("inputs") or {}
        if not isinstance(prompt_inputs, dict):
            prompt_inputs = {}
        # Pick up crop values that were edited via the JS overlay
        # (which writes to prompt.inputs rather than the hidden
        # widgets). The widget arguments above act as a fallback
        # for the initial render before the user touches anything.
        def _crop_from(name, default):
            value = prompt_inputs.get(name, default)
            try:
                return float(value) if value is not None else float(default)
            except (TypeError, ValueError):
                return float(default)
        裁剪X = _crop_from("裁剪X", 裁剪X if 裁剪X is not None else 0.0)
        裁剪Y = _crop_from("裁剪Y", 裁剪Y if 裁剪Y is not None else 0.0)
        裁剪W = _crop_from("裁剪W", 裁剪W if 裁剪W is not None else 1.0)
        裁剪H = _crop_from("裁剪H", 裁剪H if 裁剪H is not None else 1.0)
        裁剪X, 裁剪Y, 裁剪W, 裁剪H = _safe_normalize_crop(裁剪X, 裁剪Y, 裁剪W, 裁剪H)
        images = _normalize_images(images)
        using_image_batch = images is not None
        images_cache_key = _get_images_cache_key(images, force_size, _used_short, _used_long, 裁剪X, 裁剪Y, 裁剪W, 裁剪H, size_multiple) if using_image_batch else None

        slider_data = prompt_inputs.get("in_out_point_slider") or {}
        total_frames = _safe_int(slider_data.get("totalFrames"), 0)
        frame_rate = _safe_float(slider_data.get("frameRate"), 0.0)

        graph_id_value = graph_id if graph_id is not None else prompt_inputs.get("graph_id", "")
        send_progress(unique_id, graph_id_value, "Reading media info...")

        full_video_path = None
        original_total_frames = 0
        forced_mode = False
        forced_fps = 0.0
        video_width = 0
        video_height = 0
        if using_image_batch:
            total_from_images = _get_images_length(images)
            total_frames = _safe_int(total_from_images, 1)
            original_total_frames = total_frames
            # Read the spatial dimensions directly from the IMAGE tensor
            # (shape is (N, H, W, C)). The user might still pass a force_size
            # that resizes the batch, but the "original" width/height the
            # downstream 视频信息解包 node reports is the *source* size.
            try:
                video_height = int(images.shape[1])
                video_width = int(images.shape[2])
            except Exception:
                pass
            if _safe_float(fps, 0.0) > 0.0:
                frame_rate = float(fps)
            elif _safe_float(强制帧率, 0.0) > 0.0:
                forced_fps = max(1.0, min(60.0, float(强制帧率)))
                frame_rate = forced_fps
            elif frame_rate <= 0.0:
                frame_rate = 30.0
        else:
            if not isinstance(视频路径, str) or not 视频路径.strip():
                raise ValueError("video_path is required when images input is not connected")
            full_video_path = zyf_fix_path(视频路径)
            info_frame_rate, info_total_frames, info_duration, info_width, info_height = get_video_info(full_video_path)
            original_frame_rate = _safe_float(info_frame_rate, 1.0)
            original_duration = float(info_duration) if info_duration else 0.0
            original_total_frames = _safe_int(info_total_frames, 1)
            video_width = _safe_int(info_width, 0)
            video_height = _safe_int(info_height, 0)
            frame_rate = original_frame_rate
            if _safe_float(强制帧率, 0.0) > 0.0:
                forced_fps = max(1.0, min(60.0, float(强制帧率)))
                frame_rate = forced_fps
                # Recompute total frames based on the forced fps and the video's actual duration,
                # so that the output reflects the new frame rate immediately.
                if original_duration > 0.0:
                    total_frames = int(round(original_duration * forced_fps))
                else:
                    total_frames = original_total_frames
                forced_mode = True
            else:
                total_frames = original_total_frames

        in_point = _safe_int(
            prompt_inputs.get("开始帧", prompt_inputs.get("入点帧")),
            _safe_int(slider_data.get("startMarkerFrame"), 1),
        )
        out_point = _safe_int(
            prompt_inputs.get("结束帧", prompt_inputs.get("出点帧")),
            _safe_int(slider_data.get("endMarkerFrame"), total_frames),
        )
        current_frame = _safe_int(prompt_inputs.get("当前帧"), _safe_int(slider_data.get("currentFrame"), in_point))

        in_point = max(1, min(in_point, total_frames))
        out_point = max(in_point, min(out_point, total_frames))
        current_frame = max(1, min(current_frame, total_frames))

        select_every_nth_frame = _safe_int(prompt_inputs.get("帧间隔"), 1)
        if select_every_nth_frame <= 0:
            select_every_nth_frame = 1

        # 2026-07-21: 结束帧 widget 现在前端展示为"区间总帧数(count)",
        # 而不是绝对帧号 —— 用户拖动开始帧时结束帧会自动跟着调整。
        # 因此这里把 out_point 解读为 count,frames_to_process 直接等于 out_point。
        # 选区对应的绝对末帧位 = in_point + count - 1,供音频裁剪 / 区间计算使用。
        frames_to_process = out_point
        range_end_absolute = in_point + out_point - 1
        starting_frame = in_point

        # ---- 分段计划逻辑 ----
        # 分段计划开启时,按分段长度将选中区间拆分为多段,根据分段索引导出对应段。
        # 前端发送"启用"/"禁用"字符串,也兼容布尔值。
        _seg_plan_raw = prompt_inputs.get("分段计划", False)
        segment_plan_enabled = (
            _seg_plan_raw is True
            or _seg_plan_raw == "启用"
            or (_seg_plan_raw is not False and str(_seg_plan_raw).lower() == "true")
        )
        segment_count = 1
        segment_index = 0
        segment_batch_id = ""
        seg_start_offset = 0
        seg_frames = frames_to_process
        segment_length_raw = _safe_int(prompt_inputs.get("分段长度"), 81)
        segment_length_raw = max(41, min(99999, segment_length_raw))
        segment_sizes = [frames_to_process]
        if segment_plan_enabled and frames_to_process > 0:
            segment_sizes = _compute_segment_sizes(frames_to_process, segment_length_raw, min_last=33)
            segment_count = len(segment_sizes)

            # 分段索引由前端JS自动递增并排队, Python直接读取widget值
            segment_index = _safe_int(prompt_inputs.get("分段索引"), 0)
            segment_index = max(0, min(segment_index, segment_count - 1))

            # 生成分段批次ID:第一段时创建新ID,后续段复用(节点实例在多次执行间保持)
            if segment_index == 0:
                self._zyf_segment_batch_id = uuid.uuid4().hex[:12]
            segment_batch_id = getattr(self, "_zyf_segment_batch_id", None)
            if not segment_batch_id:
                segment_batch_id = uuid.uuid4().hex[:12]
                self._zyf_segment_batch_id = segment_batch_id

            # 计算当前段的起始偏移和帧数(基于各段实际大小)
            seg_start_offset = sum(segment_sizes[:segment_index])
            seg_frames = segment_sizes[segment_index]
            if seg_frames > 0:
                starting_frame = in_point + seg_start_offset
                frames_to_process = seg_frames
                range_end_absolute = starting_frame + seg_frames - 1
                # current_frame 也需要调整到段内
                if current_frame < starting_frame:
                    current_frame = starting_frame
                elif current_frame > range_end_absolute:
                    current_frame = range_end_absolute

            print(f"[ZYF] 分段计划: 索引 {segment_index}/{segment_count - 1} (共{segment_count}段), "
                  f"帧 {starting_frame}-{range_end_absolute}, 段长 {seg_frames}")

        # When forced_frame_rate is active, the in/out/currentFrame values are
        # interpreted in the *forced* timeline (1..total_frames). To honor the
        # user's "抽帧 instead of 截取" request, we remap those values back to
        # the original video frame indices (1-based) and extract them directly,
        # so that the whole video is still covered and frames are evenly
        # distributed from the original source.
        forced_indices = None
        forced_target_frame_time = 0.0
        # Bounds (in *original* video frames) for audio alignment. We use
        # the actual frame indices we are about to read, so audio lines up
        # with the visual span even if the remap introduces rounding error.
        forced_audio_start_frame = 0
        forced_audio_end_frame = 0
        forced_current_image_index = current_frame
        if forced_mode and original_total_frames > 0 and total_frames > 0 and not using_image_batch:
            map_step = float(original_total_frames) / float(total_frames)
            forced_indices = []
            forced_target_frame_time = 1.0 / frame_rate if frame_rate else 0.0
            # 使用分段后的 starting_frame 作为基准
            for offset in range(0, frames_to_process):
                forced_idx = starting_frame - 1 + offset
                orig_idx = int(round(forced_idx * map_step)) + 1
                if orig_idx < 1:
                    orig_idx = 1
                elif orig_idx > original_total_frames:
                    orig_idx = original_total_frames
                forced_indices.append(orig_idx)
            # Also remap the current image frame number into the original timeline
            current_image_orig_idx = int(round((current_frame - 1) * map_step)) + 1
            if current_image_orig_idx < 1:
                current_image_orig_idx = 1
            elif current_image_orig_idx > original_total_frames:
                current_image_orig_idx = original_total_frames
            forced_current_image_index = current_image_orig_idx
            # Audio bounds come from the actual frame indices we'll read, which
            # guarantees perfect alignment with the visual span.
            if forced_indices:
                forced_audio_start_frame = forced_indices[0]
                forced_audio_end_frame = forced_indices[-1]

        if using_image_batch:
            output_cache_key = (
                images_cache_key,
                current_frame,
                in_point,
                out_point,
                select_every_nth_frame,
                segment_plan_enabled,
                segment_index if segment_plan_enabled else 0,
                seg_frames if segment_plan_enabled else 0,
            )
            cached_output = getattr(self, "_zyf_cached_output", None)
            if cached_output and cached_output.get("key") == output_cache_key:
                current_image = cached_output.get("current_image")
                in_out_images = cached_output.get("in_out_images")
                if current_image is None or in_out_images is None:
                    current_image = None
                    in_out_images = None
                else:
                    self.target_frame_time = 1.0 / frame_rate if frame_rate else 0.0
                    audio_value = audio if audio is not None else _empty_audio_bytes()
                    filename_value = ""
            if current_image is None or in_out_images is None:
                send_progress(unique_id, graph_id_value, "Preparing frames...")
                cached_images = getattr(self, "_zyf_cached_images", None)
                if cached_images and cached_images.get("key") == images_cache_key:
                    resized_images = cached_images.get("images")
                else:
                    resized_images = _resize_image_batch(images, force_size, _used_short, _used_long, 裁剪X, 裁剪Y, 裁剪W, 裁剪H, size_multiple)
                    self._zyf_cached_images = {"key": images_cache_key, "images": resized_images}
                current_index = max(0, current_frame - 1)
                current_image = resized_images[current_index:current_index + 1]
                # 使用分段后的 starting_frame 和 frames_to_process
                in_index = max(0, starting_frame - 1)
                out_index = in_index + frames_to_process
                in_out_images = resized_images[in_index:out_index:select_every_nth_frame]
                self.target_frame_time = 1.0 / frame_rate if frame_rate else 0.0
                audio_value = audio if audio is not None else _empty_audio_bytes()
                filename_value = ""
                self._zyf_cached_output = {
                    "key": output_cache_key,
                    "current_image": current_image,
                    "in_out_images": in_out_images,
                }
        else:
            send_progress(unique_id, graph_id_value, "Extracting frames...")
            if forced_indices is not None:
                # Forced-frame-rate path: extract the exact original-video frame
                # indices that correspond to the user's in..out range on the
                # forced timeline. This is a true 抽帧 mapping: the same span of
                # the original video is preserved, just sampled at the new rate.
                (current_image, _) = getImageBatchByIndices(
                    full_video_path,
                    [forced_current_image_index],
                    force_size,
                    _used_short,
                    _used_long,
                    裁剪X,
                    裁剪Y,
                    裁剪W,
                    裁剪H,
                    size_multiple,
                )
                (in_out_images, target_frame_time) = getImageBatchByIndices(
                    full_video_path,
                    forced_indices,
                    force_size,
                    _used_short,
                    _used_long,
                    裁剪X,
                    裁剪Y,
                    裁剪W,
                    裁剪H,
                    size_multiple,
                )
                # Expose the forced (new) frame duration to downstream nodes so
                # audio and downstream consumers stay in sync with the new rate.
                self.target_frame_time = 1.0 / frame_rate if frame_rate else target_frame_time
            else:
                (current_image, _) = getImageBatch(full_video_path, 1, 1, current_frame - 1, force_size, _used_short, _used_long, 裁剪X, 裁剪Y, 裁剪W, 裁剪H, size_multiple)
                (in_out_images, target_frame_time) = getImageBatch(full_video_path, frames_to_process, select_every_nth_frame, starting_frame - 1, force_size, _used_short, _used_long, 裁剪X, 裁剪Y, 裁剪W, 裁剪H, size_multiple)
                self.target_frame_time = target_frame_time

            if audio is not None:
                send_progress(unique_id, graph_id_value, "Aligning audio...")
                audio_value = audio
            else:
                send_progress(unique_id, graph_id_value, "Extracting audio...")
                # In forced-fps mode, the audio must come from the *original*
                # video's time axis (since ffmpeg cannot time-stretch here), and
                # the slice must match the actual original frames we extracted.
                # We use forced_audio_start_frame / forced_audio_end_frame so
                # the audio is perfectly aligned with the visual span, even
                # when the remap rounds and the (in_point, out_point) range
                # does not correspond to a whole number of original seconds.
                if forced_mode and original_frame_rate > 0 and forced_audio_end_frame > 0:
                    audio_start = (forced_audio_start_frame - 1) / original_frame_rate
                    audio_duration = (forced_audio_end_frame - forced_audio_start_frame + 1) / original_frame_rate
                    target_audio_duration = frames_to_process * self.target_frame_time
                    if audio_duration > 0.0 and target_audio_duration > 0.0:
                        atempo_factor = target_audio_duration / audio_duration
                    else:
                        atempo_factor = 1.0
                    audio_value = zyf_lazy_eval(lambda: zyf_get_audio_atempo(
                        full_video_path,
                        max(0.0, audio_start),
                        max(0.0, audio_duration),
                        atempo_factor,
                    ))
                else:
                    audio_value = zyf_lazy_eval(lambda: zyf_get_audio(
                        full_video_path,
                        max(0.0, (starting_frame - 1) * self.target_frame_time),
                        frames_to_process * self.target_frame_time,
                    ))
            filename_value = 视频路径

        # current_frame_relative: 当前帧在导出段内的相对位置(从1开始)
        current_frame_relative = current_frame - starting_frame + 1
        # The "width" / "height" in the info dict reflect the *post-crop*
        # output dimensions so downstream consumers can match their
        # tensors / canvases without re-deriving the math.
        try:
            _out_h = int(in_out_images.shape[1])
            _out_w = int(in_out_images.shape[2])
        except Exception:
            _out_h, _out_w = int(video_height), int(video_width)
        # 时长(秒)字段命名沿用 VHS 视频信息包的风格(duration),
        # 因为本节点同时有"原始全片"和"用户选中区间"两种时长,
        # 加 initial_/selected_ 前缀区分。
        #   - initial_duration  : 视频原始总时长
        #                         = total_frames / frame_rate
        #                         force_frame_rate 不会改变物理时长,
        #                         因此用输出维度的 total_frames/frame_rate
        #                         算出来的就是原片总时长(秒)。
        #   - selected_duration : 用户选中区间(开始帧 → 结束帧)的时长
        #                         = (out_point - in_point + 1) / frame_rate
        #                         这是最终导出片段的物理时长(秒)。
        initial_duration = (float(total_frames) / float(frame_rate)) if frame_rate else 0.0
        # selected_duration 使用实际导出的帧数(分段后)计算
        selected_duration = (float(frames_to_process) / float(frame_rate)) if frame_rate else 0.0
        # 原始用户选区时长(分段前)
        original_selected_duration = (float(out_point) / float(frame_rate)) if frame_rate else 0.0
        video_info = {
            "in_point": in_point,
            "out_point": out_point,
            "total_frames": total_frames,
            "frames_to_process": frames_to_process,
            "current_frame": current_frame,
            "current_frame_relative": current_frame_relative,
            "frame_rate": int(round(frame_rate)) if frame_rate else 0,
            "filename": filename_value,
            "width": _out_w,
            "height": _out_h,
            "source_width": int(video_width),
            "source_height": int(video_height),
            "initial_duration": round(initial_duration, 3),
            "selected_duration": round(selected_duration, 3),
            "crop_x": round(裁剪X, 3),
            "crop_y": round(裁剪Y, 3),
            "crop_w": round(裁剪W, 3),
            "crop_h": round(裁剪H, 3),
            # 分段计划信息
            "segment_plan_enabled": segment_plan_enabled,
            "segment_count": segment_count,
            "segment_index": segment_index if segment_plan_enabled else 0,
            "segment_length": segment_length_raw if segment_plan_enabled else 0,
            "segment_start_frame": starting_frame,
            "segment_end_frame": range_end_absolute,
            "segment_batch_id": segment_batch_id if segment_plan_enabled else "",
        }
        # ---- 分段计划自动排队: 通知前端递增索引并排队下一段 ----
        if segment_plan_enabled and segment_index < segment_count - 1:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "zyf-segment-auto-queue",
                    {
                        "uid": unique_id,
                        "next_index": segment_index + 1,
                        "segment_count": segment_count,
                    },
                )
            except Exception as e:
                print(f"[ZYF] 分段自动排队消息发送失败: {e}")
        # Only the high-traffic outputs are kept on the main node. Anything
        # else (in_point / out_point / filename / total_frames / frames_to_process
        # / current_frame abs+rel / frame_rate int / width / height) is accessible
        # via the ZYF_VIDEO_INFO composite output and the 解包 node.
        return (
            current_image,
            in_out_images,
            audio_value,
            video_info,
        )


class ZyfFrameInfoUnpack:
    """解包 zyf加载视频 节点输出的 ZYF_VIDEO_INFO 复合信息包。
    将视频信息拆分为独立的字段(首帧图像/尾帧图像/帧数/帧率/宽高/时长等),
    方便下游节点按需连线使用。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "视频信息": ("ZYF_VIDEO_INFO", {
                    "tooltip": "zyf加载视频 节点输出的复合视频信息包。连接后解包为所有独立字段(首帧/尾帧图像、帧数/帧率/宽高/时长等)。",
                }),
            },
            "optional": {
                "视频帧": ("IMAGE", {
                    "tooltip": "可选: 连接 zyf加载视频 的 '视频帧(选中)' 输出, 用于提取首帧和尾帧图像。不连接时首帧/尾帧输出为 1×1 空白占位图像。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "INT", "INT", "INT", "INT", "INT", "INT", "INT", "STRING",
                    "FLOAT", "FLOAT")
    RETURN_NAMES = ("首帧图像", "尾帧图像", "帧数(初始)", "帧数(选中)", "当前帧(初始)", "当前帧(选中)", "帧率(整数)", "宽度", "高度", "文件名",
                    "初始时长(秒)", "选中时长(秒)")
    OUTPUT_NODE = False
    CATEGORY = "zyf-video"
    FUNCTION = "unpack"

    def unpack(self, 视频信息, 视频帧=None):
        info = 视频信息 if isinstance(视频信息, dict) else {}
        in_point = _safe_int(info.get("in_point"), 0)
        out_point = _safe_int(info.get("out_point"), 0)
        total_frames = _safe_int(info.get("total_frames"), 0)
        # 帧数(选中): 当前入/出点区间内选中的帧数, 从 video_info 兜底取 total_frames
        # (老信息包 / 旧工作流不携带该字段时, 选区间按"全部"处理)。
        frames_to_process = _safe_int(info.get("frames_to_process"), total_frames)
        current_frame = _safe_int(info.get("current_frame"), 0)
        current_frame_relative = _safe_int(
            info.get("current_frame_relative"),
            current_frame - in_point + 1 if (in_point and current_frame) else 0,
        )
        frame_rate = _safe_int(info.get("frame_rate"), 0)
        width = _safe_int(info.get("width"), 0)
        height = _safe_int(info.get("height"), 0)
        filename = info.get("filename", "")
        if filename is None:
            filename = ""
        if not isinstance(filename, str):
            filename = str(filename)
        # 时长(秒)。信息包里没带时按 total_frames/frame_rate 兜底,
        # 这样旧工作流(未含 initial_duration/selected_duration)也能
        # 解出合理值,行为与 VHS 视频信息包一致。
        initial_duration = _safe_float(info.get("initial_duration"), 0.0)
        if initial_duration <= 0.0 and frame_rate > 0 and total_frames > 0:
            initial_duration = float(total_frames) / float(frame_rate)
        selected_duration = _safe_float(info.get("selected_duration"), 0.0)
        # 用实际输出帧数frames_to_process计算选中时长,分段计划下也正确
        if selected_duration <= 0.0 and frame_rate > 0 and frames_to_process > 0:
            selected_duration = float(frames_to_process) / float(frame_rate)

        # -- 提取首帧 / 尾帧图像 ------------------------------------------
        # 当用户连接了 '视频帧' 输入时,从图像批中取出第一帧和最后一帧。
        # 未连接时返回 1×1 空白占位张量,避免下游节点崩溃。
        first_frame = _extract_frame(视频帧, 0)
        last_frame = _extract_frame(视频帧, -1)

        return (
            first_frame,
            last_frame,
            total_frames,
            frames_to_process,
            current_frame,
            current_frame_relative,
            frame_rate,
            width,
            height,
            filename,
            initial_duration,
            selected_duration,
        )


class ZyfVideoLoaderV2(ZyfVideoLoader):

    RETURN_TYPES = ("IMAGE", "IMAGE", "FLOAT", "AUDIO", "ZYF_VIDEO_INFO",)
    RETURN_NAMES = ("当前图像", "视频帧(选中)", "帧率(浮点)", "音频", "视频信息",)
    OUTPUT_NODE = False
    CATEGORY = "zyf-video"
    FUNCTION = "process_video"

    def process_video(
        self,
        视频路径,
        强制尺寸,
        自定义短边,
        自定义长边,
        图像尺寸倍数="无",
        强制帧率=0.0,
        裁剪X=0.0,
        裁剪Y=0.0,
        裁剪W=1.0,
        裁剪H=1.0,
        images=None,
        audio=None,
        fps=None,
        graph_id=None,
        prompt=None,
        unique_id=None,
        自定义宽度=None,
        自定义高度=None,
        分段计划="禁用",
        分段长度=81,
        分段索引=0,
        分段批次编号=0,
    ):
        result = super().process_video(
            视频路径,
            强制尺寸,
            自定义短边,
            自定义长边,
            图像尺寸倍数,
            强制帧率,
            裁剪X,
            裁剪Y,
            裁剪W,
            裁剪H,
            images,
            audio,
            fps,
            graph_id,
            prompt,
            unique_id,
            自定义宽度=自定义宽度,
            自定义高度=自定义高度,
            分段计划=分段计划,
            分段长度=分段长度,
            分段索引=分段索引,
            分段批次编号=分段批次编号,
        )
        # ZyfVideoLoader returns a 4-tuple:
        #   (当前图像, 视频帧(选中), 音频, 视频信息)
        # ZyfVideoLoaderV2 needs a couple of fields that ZyfVideoLoader doesn't expose as separate
        # outputs (in_point, total_frames, frames_to_process, frame_rate) but they are all
        # inside the composite video_info payload at result[3]. Pull them
        # out from there rather than indexing beyond the tuple length.
        video_info = result[3] if len(result) > 3 else {}
        in_point = _safe_int(video_info.get("in_point"), 1)
        total_frames = _safe_int(video_info.get("total_frames"), 0)
        frames_to_process = _safe_int(video_info.get("frames_to_process"), total_frames)
        # ZyfVideoLoader stores frame_rate as an int-rounded value in the info
        # payload; we want the original float back here for the
        # 帧率(浮点) output port. The original frame rate is also
        # available on the preview widget value during execution, but
        # since we are in a backend node, we re-derive it from the
        # target frame time which the base class set up.
        frame_rate = 0.0
        try:
            tft = float(self.target_frame_time)
            if tft > 0:
                frame_rate = 1.0 / tft
        except Exception:
            frame_rate = 0.0
        if frame_rate <= 0.0:
            frame_rate = _safe_float(video_info.get("frame_rate"), 0.0)
        # In forced-frame-rate mode, the ZyfVideoLoader result already accounts for the
        # remap and frames_to_process is the number of frames to keep, so we
        # must NOT re-apply select_every_nth_frame to audio duration here.
        forced_audio = _safe_float(强制帧率, 0.0) > 0.0

        prompt_inputs = {}
        if isinstance(prompt, dict):
            node_data = prompt.get(str(unique_id)) or prompt.get(unique_id) or {}
            if isinstance(node_data, dict):
                prompt_inputs = node_data.get("inputs") or {}
        if not isinstance(prompt_inputs, dict):
            prompt_inputs = {}
        select_every_nth_frame = _safe_int(prompt_inputs.get("帧间隔"), 1)
        if select_every_nth_frame <= 0:
            select_every_nth_frame = 1
        graph_id_value = graph_id if graph_id is not None else prompt_inputs.get("graph_id", "")

        # 使用分段计划后的实际起始帧(如果启用),否则用原始in_point
        seg_enabled = bool(video_info.get("segment_plan_enabled", False))
        effective_start_frame = _safe_int(video_info.get("segment_start_frame", in_point), in_point)
        if not seg_enabled:
            effective_start_frame = in_point

        using_image_batch = _normalize_images(images) is not None
        trim_start = max(0.0, (effective_start_frame - 1) * self.target_frame_time)
        if forced_audio:
            trim_duration = frames_to_process * self.target_frame_time
        else:
            trim_duration = frames_to_process * self.target_frame_time * select_every_nth_frame
        total_duration = total_frames * self.target_frame_time
        if audio is not None:
            send_progress(unique_id, graph_id_value, "Aligning audio...")
            audio_value = _align_audio_to_video(audio, total_duration, trim_start, trim_duration)
        elif using_image_batch:
            audio_value = _safe_audio_output_dict(_empty_audio_dict())
        else:
            full_video_path = zyf_fix_path(视频路径)
            audio_value = zyf_lazy_get_audio(
                full_video_path,
                trim_start,
                trim_duration
            )
        audio_value = _safe_audio_output_dict(audio_value)

        safe_frame_rate = _safe_float(frame_rate, 0.0)
        if safe_frame_rate <= 0.0:
            safe_frame_rate = 30.0 if total_frames else 0.0

        # ZyfVideoLoader's return tuple is (当前图像, 视频帧(选中), 音频, 视频信息).
        # ZyfVideoLoaderV2 keeps ZyfVideoLoader's first 2 outputs as-is, then adds its own 帧率(浮点),
        # an audio stream it has re-aligned to the visual span, and the
        # composite video_info for downstream 解包 users.
        return (
            result[0],               # 当前图像
            result[1],               # 视频帧(选中)
            safe_frame_rate,         # 帧率(浮点)
            audio_value,             # 音频
            result[3],               # 视频信息
        )


def _save_zyf_saver_temp_audio(audio, base_dir, subfolder="zyf_video_saver"):
    """Serialize a ComfyUI AUDIO payload (waveform tensor + sample_rate) to
    a temporary 16-bit PCM WAV file so ffmpeg can mux it into the MP4
    alongside the encoded video. Returns the absolute path on success,
    or None if the audio payload is empty or invalid.
    """
    audio_dict = _normalize_audio_dict(audio)
    if not audio_dict:
        return None
    sample_rate = int(audio_dict.get("sample_rate") or 44100)
    if sample_rate <= 0:
        sample_rate = 44100
    waveform = _ensure_waveform_tensor(audio_dict.get("waveform"))
    if waveform is None or waveform.numel() == 0:
        return None
    waveform = waveform.detach().cpu().float().squeeze(0)
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    waveform = torch.clamp(waveform, -1.0, 1.0)
    audio_np = (waveform * 32767.0).to(torch.int16).numpy()
    interleaved = audio_np.T.reshape(-1)
    target_dir = os.path.join(base_dir, subfolder)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError:
        return None
    timestamp = int(time.time() * 1000)
    audio_path = os.path.join(target_dir, f"audio_{timestamp}.wav")
    # On Windows, apply the \\?\ extended-length prefix when the temp
    # audio path itself is so deep under a long user-chosen subfolder
    # that it would otherwise exceed MAX_PATH (260). This is the same
    # fix applied at the ffmpeg call site; the temp file is created
    # here and later passed to ffmpeg via the same helper, so both
    # ends see the same path form.
    audio_path_open = _win_extended_path(audio_path)
    try:
        with wave.open(audio_path_open, "wb") as wav:
            wav.setnchannels(int(audio_np.shape[0]))
            wav.setsampwidth(2)
            wav.setframerate(int(sample_rate))
            wav.writeframes(interleaved.tobytes())
    except (OSError, wave.Error):
        try:
            os.remove(audio_path_open)
        except OSError:
            pass
        return None
    return audio_path


def _write_ffmetadata_file(path, metadata):
    """Write metadata to a temp file in ffmpeg's ``ffmetadata`` format.

    Background — why this exists:
        The naive way to embed metadata in ffmpeg is one CLI flag per
        entry: ``ffmpeg ... -metadata title=Foo -metadata workflow=<JSON>
        ...``. That works for small payloads but is catastrophic when
        the metadata contains the ComfyUI workflow JSON, which is
        routinely 50-500 KB. The full command-line string is then
        50-500 KB, blowing past the Windows ``CreateProcessW`` limit
        (32,767 chars) AND tripping the per-arg ``MAX_PATH`` check
        (260 chars) for the ``workflow=...`` arg itself. The OS error
        surfaces as ``FileNotFoundError: [WinError 206] 文件名或扩
        展名太长。`` from ``subprocess._execute_child`` before ffmpeg
        is ever launched. The file name in the error message is a
        red herring — the actual culprit is the metadata argument.

    The fix:
        ffmpeg's ``ffmetadata`` demuxer reads metadata from a file.
        We write the entire payload to a temp ``.ffmeta`` file and
        reference it as an additional ``-i`` input, then merge its
        tags onto the output via ``-map_metadata N``. This keeps the
        command line short and works regardless of metadata size.

    File format (per ffmpeg docs):
        ``;FFMETADATA1`` header on the first line, then ``key=value``
        per line. Newlines inside a value MUST be escaped as the
        two-character sequence ``\\n`` (backslash + n), NOT as a real
        newline — the multi-line ``key=\\nvalue\\n=\\n`` form is
        documented but unreliable across ffmpeg builds (the value
        comes back empty on several common builds, including the
        imageio-ffmpeg binary many ComfyUI installs ship with).
        Verified by direct experiment: single-line value of 28 KB is
        roundtripped correctly, while the same content in multi-line
        form comes back empty. The single-line approach also keeps
        the file's line structure trivial to reason about.

    Our payloads are produced with ``json.dumps(..., ensure_ascii=False,
    separators=(",", ":"))`` which strips ALL whitespace (including
    newlines) from the JSON serialization, so the values are already
    on a single line. If a string value contains a real newline
    character (rare for ComfyUI workflows but possible for ``note`` /
    ``description`` fields), we escape it as ``\\n`` so the ffmeta
    file stays single-line per entry.

    Args:
        path: Filesystem path to write to. The caller is responsible
            for the directory existing and for cleaning the file up.
        metadata: ``{key: value}`` dict; ``None`` / empty dict is a
            no-op (the file is still created but contains only the
            header so ffmpeg has something to open).
    """
    if not metadata:
        # Write the header-only file so ffmpeg has a valid (empty)
        # metadata stream to attach. Better than skipping the -i and
        # then having to track that fact in the caller.
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(";FFMETADATA1\n")
        return

    lines = [";FFMETADATA1"]
    for k, v in metadata.items():
        if v is None:
            continue
        try:
            k_s = str(k)
            v_s = str(v)
        except Exception:
            continue
        # Single-line form. Escape real newlines and carriage returns
        # as the two-character sequences ffmpeg expects. ``=`` and
        # ``;`` are not special inside a value per the spec, so they
        # pass through as-is.
        v_s = v_s.replace("\\", "\\\\")  # escape existing backslashes FIRST
        v_s = v_s.replace("\r", "\\r")
        v_s = v_s.replace("\n", "\\n")
        lines.append(f"{k_s}={v_s}")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(lines) + "\n")


def _zyf_encode_video_with_ffmpeg(
    images,
    frame_rate,
    codec,
    pix_fmt,
    crf,
    audio_path,
    output_path,
    metadata=None,
    value_range="auto",
):
    """Pipe an image batch to ffmpeg and encode to MP4.

    2026-07-15 内存优化(参照 VHS VideoCombine 的逐帧流式写法):
        老实现要求调用方先把整批 `[N, H, W, C]` float 一次性转 uint8,
        一次分配两份连续数组(float 12 GiB + uint8 3 GiB),峰值 ~27 GiB,
        2689 帧 832x480x3 的 5x 慢动作 RIFE 输出直接 OOM。
        现在改成按帧迭代 torch 张量 → 单帧转 uint8 → 写入 ffmpeg stdin,
        峰值只剩原 tensor(~12 GiB) + 单帧 uint8(~1.2 MiB),一帧一回收。

    `images` is a torch.Tensor (or anything that supports `len()` and
    `images[i]` returning a `[H, W, C]`-shaped torch.Tensor) in RGB
    float [0, max_val]. `value_range` selects the scaling:
        - "auto"     : use the first frame's max as the upper bound
        - "normalized": assume [0, 1] and multiply by 255
        - "raw"      : assume already in [0, 255] and just clip+cast
    Returns the ffmpeg return code; raises RuntimeError on failure.
    """
    if ffmpeg_path is None:
        raise RuntimeError("ffmpeg is not available; please install ffmpeg and ensure it is on PATH")
    if images is None:
        raise RuntimeError("images batch is empty; cannot encode video")
    try:
        N = int(len(images))
    except TypeError:
        raise RuntimeError("images batch has no length; expected a tensor or sequence")
    if N <= 0:
        raise RuntimeError("images batch is empty; cannot encode video")
    # Probe H, W, C from the first frame without materializing the rest.
    try:
        first_frame = images[0]
    except Exception:
        raise RuntimeError("images batch is not indexable; expected a tensor or sequence")
    try:
        if hasattr(first_frame, "shape"):
            shape = tuple(int(s) for s in first_frame.shape)
        else:
            arr = np.asarray(first_frame)
            shape = tuple(int(s) for s in arr.shape)
    except Exception:
        raise RuntimeError("images batch has unexpected frame shape; expected [H, W, C]")
    if len(shape) != 3 or shape[0] <= 0 or shape[1] <= 0:
        raise RuntimeError("images batch has unexpected frame shape; expected [H, W, C]")
    H, W, C = shape
    if C not in (3, 4):
        raise RuntimeError(
            f"images batch has unsupported channel count {C}; expected 3 (RGB) or 4 (RGBA)"
        )

    # Decide the value-range scaling once, from a single-frame sample.
    # This replaces the old `np_arr.max()` call which used to scan the
    # full 12 GiB batch to figure out the range — now we only touch the
    # first frame (~1.2 MiB).
    if value_range == "auto":
        try:
            first_np = first_frame.detach().cpu().numpy() if hasattr(first_frame, "detach") else np.asarray(first_frame)
        except Exception:
            first_np = None
        if first_np is None or first_np.size == 0:
            value_range = "normalized"
        else:
            sample_max = float(first_np.max())
            value_range = "normalized" if sample_max <= 1.5 else "raw"

    def _frame_to_uint8_bytes(frame):
        """Convert a single [H, W, C] frame to packed RGB/RGBA bytes.

        Always returns a brand-new contiguous uint8 array sized to
        exactly H*W*C, so the caller can free it after writing.
        """
        if hasattr(frame, "detach"):
            arr = frame.detach().cpu().numpy()
        else:
            arr = np.asarray(frame)
        if arr.dtype != np.float32 and arr.dtype != np.float64:
            # Already a non-float tensor/array; treat as raw 0-255.
            arr = arr.astype(np.float32, copy=False)
        if value_range == "normalized":
            arr = np.clip(arr, 0.0, 1.0)
            arr = arr * 255.0
        else:
            arr = np.clip(arr, 0.0, 255.0)
        return np.clip(arr, 0, 255).astype(np.uint8)

    # On Windows, apply the \\?\ extended-length prefix to any path that
    # might exceed MAX_PATH (260 chars). The fix is needed at the
    # subprocess boundary — both for the ffmpeg executable itself
    # (CreateProcess's lpApplicationName) and for the input/output
    # paths embedded in the command line. Without this, a long user
    # filename_prefix like "wan2.2/some/very/deep/folder" pushes the
    # final output path past 260 and subprocess.Popen fails with
    # ``FileNotFoundError: [WinError 206] 文件名或扩展名太长。`` before
    # ffmpeg is even spawned.
    ffmpeg_path_arg = _win_extended_path(ffmpeg_path)
    audio_path_arg = _win_extended_path(audio_path) if audio_path else None
    output_path_arg = _win_extended_path(output_path)

    # Write metadata to a temp .ffmeta file rather than passing each
    # entry as a -metadata CLI flag. The ComfyUI workflow JSON alone
    # is routinely 50-500 KB; even the 30-node synthetic workflow in
    # the unit test is 9.5 KB. Passing that as ``-metadata
    # workflow=<huge JSON>`` would (a) blow the Windows command-line
    # limit (32 767 chars), and (b) trip the per-arg MAX_PATH (260)
    # check on the workflow=... argument itself — both surface as
    # ``FileNotFoundError: [WinError 206] 文件名或扩展名太长。``
    # from subprocess._execute_child, which is misleading because the
    # actual problem is the metadata argument, not the file path. By
    # routing the metadata through the ffmetadata file demuxer via
    # ``-i meta.ffmeta -map_metadata N`` we keep the command line
    # short and the OS happy.
    meta_path = None
    meta_path_arg = None
    if metadata:
        # Use the system temp dir (ComfyUI sets TEMP/TMP), with a
        # descriptive prefix so multiple concurrent runs don't clash.
        # delete=False because we need the file to outlive this
        # context manager — ffmpeg will only see the path after we
        # close the handle.
        fd, meta_path = tempfile.mkstemp(
            prefix="zyf_videosaver_meta_", suffix=".ffmeta"
        )
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            _write_ffmetadata_file(meta_path, metadata)
        except Exception as e:
            # If we can't even write the metadata file, don't fail the
            # whole encode — just drop the metadata and continue.
            # (The video is still useful; the workflow can be re-saved
            # from the .json sidecar.)
            try:
                os.remove(_win_extended_path(meta_path))
            except OSError:
                pass
            meta_path = None
        else:
            meta_path_arg = _win_extended_path(meta_path)

    try:
        # All -i inputs come first; output options follow.
        #
        # Input indices (always well-defined because the metadata
        # file — when present — is the LAST -i):
        #     no audio, no meta       -> rawvideo=0
        #     no audio, meta present  -> rawvideo=0, meta=1
        #     audio + meta            -> rawvideo=0, audio=1, meta=2
        #     audio only, no meta     -> rawvideo=0, audio=1
        i_pix_fmt = "rgba" if C == 4 else "rgb24"
        cmd = [
            ffmpeg_path_arg,
            "-y",
            "-v", "error",
            "-f", "rawvideo",
            "-pix_fmt", i_pix_fmt,
            "-s", f"{W}x{H}",
            "-r", f"{frame_rate:.6f}",
            "-i", "-",
        ]
        if audio_path_arg:
            cmd += ["-i", audio_path_arg]
        if meta_path_arg:
            cmd += ["-i", meta_path_arg]

        # ----- Codec / quality options (BEFORE any -map flags) -----
        # The codec, CRF, and pixel-format options MUST come before
        # any ``-map`` flags. On some ffmpeg builds, placing ``-map``
        # before ``-c:v`` / ``-crf`` causes the codec defaults to be
        # used instead of our explicit settings, silently producing
        # either a lossless encode (huge file) or a stream that the
        # muxer cannot write into MP4 (empty output).
        cmd += [
            "-c:v", codec,
            "-preset", "medium",
            "-pix_fmt", pix_fmt,
            "-crf", str(int(crf)),
        ]
        if audio_path:
            cmd += [
                "-c:a", "aac",
                "-b:a", "192k",
                "-shortest",
            ]

        # ----- Stream selection: explicit -map ONLY when .ffmeta is
        #       present -----
        # When a ``.ffmeta`` input is in the mix, ffmpeg's default
        # stream selection is NOT reliable: the metadata-only data
        # stream can be promoted over the rawvideo stream, producing
        # a metadata-only MP4 (the 40 KB bug). The fix is to map
        # streams explicitly — but ONLY when the .ffmeta input is
        # actually present. When there is no .ffmeta, ffmpeg's
        # default selection (best video + best audio) is correct and
        # we should NOT add ``-map``, because the ``-map`` flag can
        # interfere with the encoder's parameter application on some
        # ffmpeg builds (the "25 MB instead of 3-5 MB" bug).
        #
        # ``-map 0:v:0`` : first video stream from the rawvideo pipe.
        # ``-map 1:a:0?``: first audio stream from the audio input
        #   (``?`` = optional — skip gracefully if audio is absent
        #   or invalid; the video track still goes through).
        if meta_path_arg:
            cmd += ["-map", "0:v:0"]
            if audio_path_arg:
                cmd += ["-map", "1:a:0?"]

            # Apply the file's tags as the output's global metadata,
            # replacing anything the codec/container would infer.
            # ``-map_metadata N`` works on the global metadata block;
            # stream-level metadata (e.g. per-stream title) is
            # unaffected.
            # N is the index of the metadata input (always the last
            # -i):
            #     no audio, meta present -> 1
            #     audio + meta           -> 2
            meta_input_index = 2 if audio_path_arg else 1
            cmd += ["-map_metadata", str(meta_input_index)]

        # ----- Even-dimension fix (H.264/H.265 require W,H divisible by 2) ---
        # When two videos are stitched side-by-side, the resulting width
        # can be odd (e.g. 959 px). libx264/libx265 refuse to encode such
        # streams with "width not divisible by 2". The fix is a simple
        # ``pad`` filter that rounds up to the next even number, adding a
        # 1-pixel black border on the right/bottom edge — no cropping,
        # full image content preserved.
        even_w = W
        even_h = H
        if W % 2 != 0 or H % 2 != 0:
            even_w = W + (W % 2)
            even_h = H + (H % 2)
            cmd += ["-vf", f"pad={even_w}:{even_h}:0:0:black"]

        # ----- Muxer flags -----
        # ``+faststart``: move the moov atom to the front so playback
        #   can begin before the file is fully downloaded.
        # ``+use_metadata_tags``: preserve custom metadata keys
        #   (prompt, workflow) in the mp4's mdta atom so ComfyUI can
        #   restore them when the user drags the video file into the
        #   interface. ONLY needed when custom metadata is present;
        #   without it the flag is unnecessary and may cause the muxer
        #   to write a spurious empty mdta atom on some builds.
        if meta_path_arg:
            cmd += ["-movflags", "+faststart+use_metadata_tags"]
        else:
            cmd += ["-movflags", "+faststart"]
        cmd += [output_path_arg]

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            # 2026-07-15 内存优化: 逐帧流式转换 + 写入。
            # 旧实现先把整批 N*H*W*3 float32 一次性乘 255 再转 uint8,
            # 中间需要同时存 12 GiB float + 3 GiB uint8,峰值 ~27 GiB。
            # 现在按帧迭代 torch 张量: 每帧 ~1.2 MiB(832*480*3),
            # 转完即丢,稳态峰值 = 原 float32 tensor(~12 GiB) + 单帧。
            # 顺便喂一行 progress 给 console,免得用户盯着日志以为
            # 节点卡死 —— 2689 帧在 slow preset 下可能要几十秒。
            import sys as _sys
            progress_step = max(1, N // 20)
            frames_written = 0
            for i in range(N):
                try:
                    frame_bytes = _frame_to_uint8_bytes(images[i])
                except Exception as convert_err:
                    raise RuntimeError(
                        f"zyf保存视频: 第 {i + 1}/{N} 帧转换失败: {convert_err}"
                    ) from convert_err
                try:
                    proc.stdin.write(frame_bytes.tobytes())
                except BrokenPipeError:
                    # ffmpeg 子进程已经退(通常因为参数错误),让外层
                    # stderr 读出来抛 RuntimeError 给用户看。
                    break
                finally:
                    # 显式删引用,让本帧 uint8 立即可回收
                    del frame_bytes
                frames_written += 1
                if frames_written % progress_step == 0 or frames_written == N:
                    pct = int(frames_written * 100 / N)
                    print(
                        f"[ZYF_VideoSaver] encoding progress: {frames_written}/{N} frames ({pct}%)",
                        file=_sys.stderr,
                        flush=True,
                    )
            try:
                proc.stdin.close()
            except Exception:
                pass
            proc.wait()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            raise

        if proc.returncode != 0:
            try:
                stderr_text = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
            except Exception:
                stderr_text = ""
            raise RuntimeError(
                f"ffmpeg failed (code {proc.returncode}) while encoding to {output_path}: {stderr_text.strip()}"
            )
        return proc.returncode
    finally:
        # Clean up the temp metadata file. Symmetric with the write
        # path: if it was created with the extended-length prefix
        # applied, the matching remove needs the same prefix.
        if meta_path:
            try:
                os.remove(_win_extended_path(meta_path))
            except OSError:
                pass


def _zyf_concat_segments_with_ffmpeg(segment_paths, output_path, codec, pix_fmt, crf, frame_rate, metadata=None):
    """使用 ffmpeg concat 分离器将多个分段 MP4 拼接为一个完整视频(重编码确保音画同步)。

    参数:
        segment_paths: 分段 MP4 文件路径列表(按顺序)
        output_path:   最终输出文件路径
        codec/pix_fmt/crf/frame_rate: 编码参数
        metadata:      可选 metadata 字典(写入输出文件)
    """
    if not segment_paths:
        raise RuntimeError("没有分段文件可合并")
    if ffmpeg_path is None:
        raise RuntimeError("ffmpeg 不可用,无法合并分段视频")

    # 写 concat list 文件
    list_fd, list_path = tempfile.mkstemp(prefix="zyf_concat_", suffix=".txt")
    try:
        os.close(list_fd)
    except OSError:
        pass
    meta_path = None
    meta_path_arg = None
    try:
        with open(list_path, "w", encoding="utf-8") as f:
            for seg_path in segment_paths:
                # concat demuxer 要求路径使用单引号转义,Windows 反斜杠需转为正斜杠
                norm_path = seg_path.replace("\\", "/")
                escaped = norm_path.replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        ffmpeg_path_arg = _win_extended_path(ffmpeg_path)
        list_path_arg = _win_extended_path(list_path)
        output_path_arg = _win_extended_path(output_path)

        cmd = [
            ffmpeg_path_arg, "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", list_path_arg,
        ]

        # 如果有 metadata,写 ffmetadata 临时文件
        if metadata:
            fd, meta_path = tempfile.mkstemp(prefix="zyf_concat_meta_", suffix=".ffmeta")
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                _write_ffmetadata_file(meta_path, metadata)
                meta_path_arg = _win_extended_path(meta_path)
                cmd += ["-i", meta_path_arg]
            except Exception:
                try:
                    os.remove(_win_extended_path(meta_path))
                except OSError:
                    pass
                meta_path = None
                meta_path_arg = None

        # 编码参数(重编码以确保干净的边界和音画同步)
        cmd += [
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", codec,
            "-crf", str(int(crf)),
            "-pix_fmt", pix_fmt,
            "-r", f"{float(frame_rate):.6f}",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
        ]
        if meta_path_arg:
            cmd += ["-map_metadata", "1"]
        cmd += [output_path_arg]

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if proc.returncode != 0:
            stderr_text = proc.stderr.decode("utf-8", errors="ignore") if proc.stderr else ""
            raise RuntimeError(
                f"ffmpeg 合并分段失败 (code {proc.returncode}): {stderr_text.strip()}"
            )
    finally:
        for p in (list_path, meta_path):
            if p:
                try:
                    os.remove(_win_extended_path(p))
                except OSError:
                    pass


class ZyfVideoSaver:
    """将图像批(+可选音频)保存为 H.264 或 H.265 MP4 视频文件。

    输出到 ``comfyui/output/{filename_prefix}/`` 目录,
    文件名前缀逻辑与 VHS 合并为视频 完全一致(底层共用
    ``folder_paths.get_save_image_path``),因此支持:

      - 子文件夹: ``wan2.2/999`` -> ``comfyui/output/wan2.2/999_NNNNN.mp4``
      - 模板变量: ``%width%`` / ``%height%`` / ``%year%`` / ``%month%`` /
        ``%day%`` / ``%hour%`` / ``%minute%`` / ``%second%``
      - 自动递增 counter: 同名前缀的已有文件不会被覆盖

    三种输出模式:
        - "保存预览"   : 写入磁盘 + 节点内显示预览
        - "仅预览"     : 编码到临时文件仅预览,不保存到 output
        - "保存隐藏预览": 写入磁盘但不显示预览
    """

    SUPPORTED_FORMATS = ["H264", "H265"]
    OUTPUT_MODES = ["保存预览", "仅预览", "保存隐藏预览"]
    DEFAULT_CRF = {
        "H264": 19,
        "H265": 22,
    }

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "图片": ("IMAGE", {
                    "tooltip": "要保存为视频的图像批张量 [N, H, W, C],RGB 浮点 [0, 1]。",
                }),
                "帧率": ("FLOAT", {
                    "default": 30.0, "min": 0.1, "max": 240.0, "step": 0.1,
                    "tooltip": "输出视频的帧率(fps)。值越大播放越快越流畅,常用 24/30/60。",
                }),
                "文件名前缀": ("STRING", {
                    "default": "AnimateDiff",
                    "tooltip": "输出文件名前缀(与 VHS 合并为视频 节点保持一致)。\n"
                               "  - 留空或填 'comfyui'        -> comfyui/output/comfyui_NNNNN.mp4\n"
                               "  - 填 'wan2.2/999'           -> 自动创建子文件夹 wan2.2/ 并保存为 999_NNNNN.mp4\n"
                               "  - 填 'a/b/c/clip'           -> 嵌套子文件夹,逐级自动创建\n"
                               "  - 支持模板变量: %width% / %height%  (图像宽高)\n"
                               "                  %year% / %month% / %day%  (年月日)\n"
                               "                  %hour% / %minute% / %second%  (时分秒)\n"
                               "    例: 'video_%year%-%month%-%day%_%hour%-%minute%-%second%'\n"
                               "    ->  video_2026-07-22_03-45-12_NNNNN.mp4\n"
                               "  - 自动递增: 同名前缀已存在的文件不会被覆盖,counter 自动 +1\n"
                               "  '/' 与 '\\\\' 都会被识别为子文件夹分隔符。",
                }),
                "输出模式": (s.OUTPUT_MODES, {
                    "default": "保存预览",
                    "tooltip": "保存行为:\n"
                               "  - 保存预览       : 写入磁盘 + 节点内显示预览\n"
                               "  - 仅预览         : 编码到临时文件,仅用于节点内预览(不写入 output)\n"
                               "  - 保存隐藏预览   : 写入磁盘但节点不显示预览",
                }),
                "保存元数据": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "把 ComfyUI 工作流元数据(prompt、workflow)嵌入到 MP4 中。\n"
                               "之后把该视频拖回 ComfyUI 即可恢复完整工作流。",
                }),
                "保留临时文件": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "仅对分段计划模式生效。\n"
                               "  - 关闭(默认):最后一段合并完成后自动删除 output/zyf_segment_temp/ 临时分段文件\n"
                               "  - 开启        :保留分段文件不删除,方便查看中间产物或自行重新合并\n"
                               "                  提示:可在 console 日志中找到保留路径。",
                }),
                "编码格式": (s.SUPPORTED_FORMATS, {
                    "default": "H264",
                    "tooltip": "视频编码格式:\n"
                               "  - H264(libx264): 兼容性好,几乎所有播放器都支持,默认 CRF 19\n"
                               "  - H265(libx265): 压缩率更高(同等画质体积更小),但部分老设备兼容性差,默认 CRF 22\n"
                               "切换编码格式时,如果当前 CRF 仍是另一种格式的默认值,会自动同步到新格式的默认值。",
                }),
                "质量CRF": ("INT", {
                    "default": 19, "min": 0, "max": 51, "step": 1,
                    "tooltip": "恒定质量因子(Constant Rate Factor)。\n"
                               "  - 0  = 真正无损(文件极大)\n"
                               "  - 18 = 视觉无损(常用)\n"
                               "  - 23 = ffmpeg 默认(中等)\n"
                               "  - 51 = 最差质量\n"
                               "H264 推荐 18-23,H265 推荐 20-28。",
                }),
            },
            "optional": {
                "音频": ("AUDIO", {
                    "tooltip": "可选音频输入。连接后会编码为 AAC 192kbps 并与视频合流(以视频时长为基准)。",
                }),
                "视频信息": ("ZYF_VIDEO_INFO", {
                    "tooltip": "可选:连接 zyf加载视频 的 '视频信息' 输出,用于分段计划自动合并。\n"
                               "当分段计划开启时,各分段视频会临时保存到 output/zyf_segment_temp/ 目录,\n"
                               "最后一段完成后自动拼接为完整视频并保存到文件名前缀指定位置。\n"
                               "临时目录不会被ComfyUI自动清理,重启后可继续未完成的分段任务。",
                }),
            },
            "hidden": {
                "h264_pix_fmt": ("STRING", {"default": "yuv420p"}),
                "h265_pix_fmt": ("STRING", {"default": "yuv420p"}),
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True
    CATEGORY = "zyf-video"
    FUNCTION = "save_video"

    def save_video(
        self,
        图片,
        帧率=30.0,
        文件名前缀="AnimateDiff",
        输出模式="保存预览",
        保存元数据=True,
        保留临时文件=False,
        编码格式="H264",
        质量CRF=19,
        音频=None,
        视频信息=None,
        h264_pix_fmt="yuv420p",
        h265_pix_fmt="yuv420p",
        prompt=None,
        extra_pnginfo=None,
    ):
        # -- 解析分段计划信息 ------------------------------------------------
        seg_info = 视频信息 if isinstance(视频信息, dict) else {}
        seg_enabled = bool(seg_info.get("segment_plan_enabled", False))
        seg_count = int(seg_info.get("segment_count", 1)) if seg_enabled else 1
        seg_index = int(seg_info.get("segment_index", 0)) if seg_enabled else 0
        seg_batch_id = str(seg_info.get("segment_batch_id", "")) if seg_enabled else ""
        is_last_segment = (not seg_enabled) or (seg_index >= seg_count - 1)

        # -- Validate inputs ------------------------------------------------
        images = _normalize_images(图片)
        if images is None:
            raise ValueError("zyf保存视频: '图片' 输入是必需的")
        total_frames = _get_images_length(images)
        if total_frames <= 0:
            raise ValueError("zyf保存视频: '图片' 批中没有有效帧")
        try:
            H = int(images.shape[1])
            W = int(images.shape[2])
        except Exception:
            raise ValueError("zyf保存视频: 无法从图像批读取尺寸")
        if H <= 0 or W <= 0:
            raise ValueError("zyf保存视频: 图像批尺寸无效")

        safe_frame_rate = _safe_float(帧率, 30.0)
        if safe_frame_rate <= 0.0:
            safe_frame_rate = 30.0

        if 输出模式 not in self.OUTPUT_MODES:
            输出模式 = "保存预览"

        if 编码格式 not in self.SUPPORTED_FORMATS:
            编码格式 = "H264"
        codec = "libx264" if 编码格式 == "H264" else "libx265"
        pix_fmt = h264_pix_fmt if 编码格式 == "H264" else h265_pix_fmt
        if not isinstance(pix_fmt, str) or not pix_fmt.strip():
            pix_fmt = "yuv420p"
        safe_crf = _safe_int(质量CRF, self.DEFAULT_CRF[编码格式])
        safe_crf = max(0, min(51, safe_crf))

        # -- Resolve output path -------------------------------------------
        # 分段模式:临时存段到 zyf_segment_temp/{batch_id}/,最后一段合并到最终路径
        seg_temp_dir = None
        seg_output_path = None
        seg_audio_path = None
        metadata_payload = None
        final_output_path = None
        final_subfolder = ""
        final_filename = ""
        final_return_type = "output"

        if seg_enabled and seg_batch_id:
            # ---- 分段模式 ----
            seg_temp_dir = os.path.join(
                folder_paths.get_output_directory(),
                "zyf_segment_temp",
                seg_batch_id,
            )
            os.makedirs(seg_temp_dir, exist_ok=True)
            seg_filename = f"seg_{seg_index:04d}.mp4"
            seg_output_path = os.path.join(seg_temp_dir, seg_filename)

            # 分段临时音频存到分段目录
            seg_audio_path = None
            if 音频 is not None:
                seg_audio_path = _save_zyf_saver_temp_audio(音频, seg_temp_dir, subfolder="audio")
            save_audio = bool(seg_audio_path)

            if is_last_segment:
                # 最后一段:先确定最终输出路径(用于合并后保存)
                if 输出模式 == "仅预览":
                    final_output_dir = folder_paths.get_temp_directory()
                    final_subfolder = "zyf_video_saver"
                    final_full_folder = os.path.join(final_output_dir, final_subfolder)
                    os.makedirs(final_full_folder, exist_ok=True)
                    final_return_type = "temp"
                    ts = int(time.time() * 1000)
                    final_filename = f"preview_{ts}_{os.getpid()}_.mp4"
                    final_output_path = os.path.join(final_full_folder, final_filename)
                else:
                    final_output_dir = folder_paths.get_output_directory()
                    try:
                        _img_w = int(W) if W else 0
                        _img_h = int(H) if H else 0
                    except Exception:
                        _img_w, _img_h = 0, 0
                    (
                        final_full_folder,
                        final_base,
                        final_counter,
                        final_subfolder,
                        _resolved_prefix,
                    ) = folder_paths.get_save_image_path(
                        文件名前缀 if 文件名前缀 else "AnimateDiff",
                        final_output_dir,
                        image_width=_img_w,
                        image_height=_img_h,
                    )
                    os.makedirs(final_full_folder, exist_ok=True)
                    final_filename = f"{final_base}_{final_counter:05d}_.mp4"
                    final_output_path = os.path.join(final_full_folder, final_filename)
                    final_return_type = "output"

                # metadata 写入最终合并视频
                if 保存元数据 and 输出模式 != "仅预览":
                    from datetime import datetime, timezone
                    # 2026-07-30 修复: 用各段已编码好的实际帧数求和,而不是用
                    # current_segment_total * seg_count 估算。之前的算法在最后
                    # 一段因借帧/丢帧而长度不同时,会把错误总数写进元数据。
                    # 这里只探测 last_segment 之前的若干段(它们此时已落盘),
                    # 加上当前段 total_frames,得到精确总和。
                    actual_total_for_meta = total_frames  # 当前段(最后一段)
                    try:
                        for _si in range(seg_count - 1):
                            _sf = os.path.join(seg_temp_dir, f"seg_{_si:04d}.mp4")
                            if os.path.isfile(_sf):
                                _, _tf, _, _, _ = get_video_info(_sf)
                                if _tf and _tf > 0:
                                    actual_total_for_meta += int(_tf)
                    except Exception as e:
                        # 探测失败时退回近似算法
                        print(f"[ZYF] 警告: 探测历史段帧数失败 ({e}); 退回近似算法")
                        actual_total_for_meta = total_frames * seg_count
                    est_total_frames = actual_total_for_meta
                    duration = float(est_total_frames) / float(safe_frame_rate) if safe_frame_rate else 0.0
                    metadata_payload = {
                        "title": f"zyf保存视频 ({编码格式})",
                        "creation_time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
                        "encoder": f"zyf-{codec}",
                        "zyf_filename": final_filename,
                        "zyf_subfolder": final_subfolder,
                        "zyf_type": "output",
                        "zyf_format": 编码格式,
                        "zyf_codec": codec,
                        "zyf_pix_fmt": pix_fmt,
                        "zyf_crf": int(safe_crf),
                        "zyf_frame_rate": float(safe_frame_rate),
                        "zyf_width": int(W),
                        "zyf_height": int(H),
                        "zyf_total_frames": int(est_total_frames),
                        "zyf_duration": duration,
                        "zyf_has_audio": "1" if save_audio else "0",
                        "zyf_output_mode": str(输出模式),
                        "zyf_filename_prefix": str(文件名前缀) if isinstance(文件名前缀, str) else "comfyui",
                        "zyf_segment_count": str(seg_count),
                        "zyf_segment_batch": seg_batch_id,
                    }
                    if isinstance(prompt, dict):
                        try:
                            metadata_payload["prompt"] = json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))
                        except Exception:
                            pass
                    if isinstance(extra_pnginfo, dict):
                        try:
                            for k, v in extra_pnginfo.items():
                                metadata_payload[str(k)] = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
                        except Exception:
                            pass
        else:
            # ---- 普通模式(非分段) ----
            if 输出模式 == "仅预览":
                output_dir = folder_paths.get_temp_directory()
                subfolder = "zyf_video_saver"
                full_output_folder = os.path.join(output_dir, subfolder)
                os.makedirs(full_output_folder, exist_ok=True)
                timestamp = int(time.time() * 1000)
                file_stem = f"preview_{timestamp}_{os.getpid()}_"
                counter = 0
                base_filename = "preview"
            else:
                output_dir = folder_paths.get_output_directory()
                try:
                    _img_w = int(W) if W else 0
                    _img_h = int(H) if H else 0
                except Exception:
                    _img_w, _img_h = 0, 0
                (
                    full_output_folder,
                    base_filename,
                    counter,
                    subfolder,
                    _resolved_prefix,
                ) = folder_paths.get_save_image_path(
                    文件名前缀 if 文件名前缀 else "AnimateDiff",
                    output_dir,
                    image_width=_img_w,
                    image_height=_img_h,
                )
                os.makedirs(full_output_folder, exist_ok=True)
                file_stem = f"{base_filename}_{counter:05d}_"

            output_filename = f"{file_stem}.mp4"
            output_path = os.path.join(full_output_folder, output_filename)

            # -- Prepare audio temp file (if any) ------------------------------
            audio_path = None
            if 音频 is not None:
                audio_path = _save_zyf_saver_temp_audio(音频, output_dir)
            save_audio = bool(audio_path)

            # -- Build metadata payload (embedded in the video container) -----
            if 保存元数据 and 输出模式 != "仅预览":
                from datetime import datetime, timezone
                duration = float(total_frames) / float(safe_frame_rate) if safe_frame_rate else 0.0
                metadata_payload = {
                    "title": f"zyf保存视频 ({编码格式})",
                    "creation_time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
                    "encoder": f"zyf-{codec}",
                    "zyf_filename": output_filename,
                    "zyf_subfolder": subfolder,
                    "zyf_type": "output",
                    "zyf_format": 编码格式,
                    "zyf_codec": codec,
                    "zyf_pix_fmt": pix_fmt,
                    "zyf_crf": int(safe_crf),
                    "zyf_frame_rate": float(safe_frame_rate),
                    "zyf_width": int(W),
                    "zyf_height": int(H),
                    "zyf_total_frames": int(total_frames),
                    "zyf_duration": duration,
                    "zyf_has_audio": "1" if save_audio else "0",
                    "zyf_output_mode": str(输出模式),
                    "zyf_filename_prefix": str(文件名前缀) if isinstance(文件名前缀, str) else "comfyui",
                }
                if isinstance(prompt, dict):
                    try:
                        metadata_payload["prompt"] = json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))
                    except Exception:
                        pass
                if isinstance(extra_pnginfo, dict):
                    try:
                        for k, v in extra_pnginfo.items():
                            metadata_payload[str(k)] = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
                    except Exception:
                        pass
            else:
                metadata_payload = None

        # -- Encode the video ----------------------------------------------
        if seg_enabled and seg_batch_id:
            # 分段模式:编码当前段到临时文件(段文件不嵌入metadata,最终合并时再嵌入)
            try:
                _zyf_encode_video_with_ffmpeg(
                    images=images,
                    frame_rate=safe_frame_rate,
                    codec=codec,
                    pix_fmt=pix_fmt,
                    crf=safe_crf,
                    audio_path=seg_audio_path,
                    output_path=seg_output_path,
                    metadata=None,  # 段文件不写metadata
                    value_range="auto",
                )
            finally:
                if seg_audio_path:
                    try:
                        os.remove(_win_extended_path(seg_audio_path))
                    except OSError:
                        pass
                    # 2026-07-30: 清理空的 audio/ 工作目录。该目录只是 ffmpeg
                    # 的临时输入工作区(每段写入 WAV → ffmpeg 读取 → 删除 WAV),
                    # 段文件本身已自带音轨,合并时不再读这个目录。WAV 删完后
                    # 目录必然为空,用 os.rmdir 顺手清掉(目录非空时静默失败,
                    # 不影响主流程)。
                    try:
                        audio_dir = os.path.dirname(seg_audio_path)
                        if audio_dir and os.path.isdir(audio_dir):
                            os.rmdir(audio_dir)
                    except OSError:
                        pass

            if is_last_segment:
                # 收集所有分段文件路径(按顺序)
                segment_paths = []
                for si in range(seg_count):
                    sf = os.path.join(seg_temp_dir, f"seg_{si:04d}.mp4")
                    if os.path.isfile(sf):
                        segment_paths.append(sf)
                    else:
                        print(f"[ZYF] 警告: 分段文件缺失: {sf}")

                if not segment_paths:
                    raise RuntimeError(f"分段合并失败: 没有找到任何分段文件于 {seg_temp_dir}")

                print(f"[ZYF] 分段计划: 合并 {len(segment_paths)} 个分段到最终视频...")

                # 合并所有分段到最终输出
                _zyf_concat_segments_with_ffmpeg(
                    segment_paths=segment_paths,
                    output_path=final_output_path,
                    codec=codec,
                    pix_fmt=pix_fmt,
                    crf=safe_crf,
                    frame_rate=safe_frame_rate,
                    metadata=metadata_payload,
                )

                # 清理临时分段目录(仅当用户未开启"保留临时文件"开关)
                try:
                    if 保留临时文件:
                        # 保留分段文件,提示用户路径
                        print(f"[ZYF] 保留分段临时文件于: {seg_temp_dir}")
                        for _si in range(seg_count):
                            _sf = os.path.join(seg_temp_dir, f"seg_{_si:04d}.mp4")
                            if os.path.isfile(_sf):
                                print(f"[ZYF]   - {_sf}")
                    else:
                        shutil.rmtree(seg_temp_dir, ignore_errors=True)
                except Exception:
                    pass

                # 返回最终视频预览
                if 输出模式 == "保存隐藏预览":
                    return {"result": ()}

                # 2026-07-30 修复: 用实际合并后的文件探测真实的总帧数/帧率/时长。
                # 之前的 total_frames * seg_count 算法在最后一段因借帧/丢帧而
                # 与其他段长度不同时,会算出错误总帧数(导致预览进度条比实际长
                # 或短,例如 5 段但显示为 4 段对应的帧数)。直接读容器才是
                # 唯一可靠的做法,与磁盘上的实际视频文件保持一致。
                actual_frame_rate = float(safe_frame_rate)
                actual_total_frames = 0
                actual_duration = 0.0
                try:
                    probed_fr, probed_total, probed_dur, _w, _h = get_video_info(final_output_path)
                    if probed_fr and probed_fr > 0:
                        actual_frame_rate = float(probed_fr)
                    if probed_total and probed_total > 0:
                        actual_total_frames = int(probed_total)
                    if probed_dur and probed_dur > 0:
                        actual_duration = float(probed_dur)
                    # 兜底:如果探测拿不到(极端情况),用近似算法
                    if actual_total_frames <= 0:
                        actual_total_frames = total_frames * seg_count
                    if actual_duration <= 0 and actual_frame_rate > 0:
                        actual_duration = float(actual_total_frames) / actual_frame_rate
                    print(f"[ZYF] 分段合并完成: {final_filename} (实际 {actual_total_frames}帧, {actual_duration:.3f}s, {actual_frame_rate:.3f}fps)")
                except Exception as e:
                    print(f"[ZYF] 警告: 无法探测最终视频 {final_output_path}: {e}; 退回近似算法")
                    actual_total_frames = total_frames * seg_count
                    actual_duration = float(actual_total_frames) / float(safe_frame_rate) if safe_frame_rate else 0.0

                video_info_result = {
                    "filename": final_filename,
                    "subfolder": final_subfolder,
                    "type": final_return_type,
                    "format": "video/mp4",
                    "output_mode": 输出模式,
                    "frame_rate": actual_frame_rate,
                    "width": int(W),
                    "height": int(H),
                    "total_frames": int(actual_total_frames),
                    "duration": float(actual_duration),
                    "codec": codec,
                    "crf": int(safe_crf),
                    "pix_fmt": pix_fmt,
                }
                return {"ui": {"images": [video_info_result], "animated": (True,)}, "result": ()}
            else:
                # 非最后一段:不返回预览,等待下一段
                print(f"[ZYF] 分段 {seg_index + 1}/{seg_count} 已临时保存: {seg_filename}")
                return {"result": ()}
        else:
            # 普通模式:直接编码到最终输出
            try:
                _zyf_encode_video_with_ffmpeg(
                    images=images,
                    frame_rate=safe_frame_rate,
                    codec=codec,
                    pix_fmt=pix_fmt,
                    crf=safe_crf,
                    audio_path=audio_path,
                    output_path=output_path,
                    metadata=metadata_payload,
                    value_range="auto",
                )
            finally:
                if audio_path:
                    try:
                        os.remove(_win_extended_path(audio_path))
                    except OSError:
                        pass

            # -- Return preview info for UI ----------------------------------------
            if 输出模式 == "仅预览":
                return_type = "temp"
            else:
                return_type = "output"

            video_info = {
                "filename": output_filename,
                "subfolder": subfolder,
                "type": return_type,
                "format": "video/mp4",
                "output_mode": 输出模式,
                "frame_rate": float(safe_frame_rate),
                "width": int(W),
                "height": int(H),
                "total_frames": int(total_frames),
                "duration": float(total_frames) / float(safe_frame_rate) if safe_frame_rate else 0.0,
                "codec": codec,
                "crf": int(safe_crf),
                "pix_fmt": pix_fmt,
            }
            if 输出模式 == "保存隐藏预览":
                return {"result": ()}
            return {"ui": {"images": [video_info], "animated": (True,)}, "result": ()}


NODE_CLASS_MAPPINGS = {
    "ZyfVideoLoaderV2": ZyfVideoLoaderV2,
    "ZyfFrameInfoUnpack": ZyfFrameInfoUnpack,
    "ZyfVideoSaver": ZyfVideoSaver,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ZyfVideoLoaderV2": "zyf加载视频",
    "ZyfFrameInfoUnpack": "zyf视频信息解包",
    "ZyfVideoSaver": "zyf保存视频",
}
