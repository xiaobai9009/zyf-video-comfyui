'use strict';

// zyf保存视频 — 前端扩展
//
// 2026-07-15: 预览窗口由 ComfyUI 原生 PreviewVideo 替换为 zyf 风格
// 自定义预览(截屏按钮 / 裁剪按钮 / 音频控件 / 进度条全部沿用
// zyf加载视频同一套样式)。视频源在 onExecuted 时由 Python 端
// `{"ui": {"images": [video_info], "animated": (True,)}}` 喂进来,
// 我们劫持它不让原生 PreviewVideo 接管 —— 把 video_info 直接设到
// 自己的 <video> 元素上。
//
// 同步逻辑保留:H264/H265 切换时自动同步 CRF 默认值。

console.log("[zyf-video] videoSaver.js loaded - Version: 2026-07-28-fix-bg-preview");

import { app, ANIM_PREVIEW_WIDGET } from "../../../scripts/app.js";
import { applyZyfTooltips } from "../utils.js";
import {
    createZYFStyleScreenshotButton,
    createZYFStyleAudioControl,
    createZYFStyleCropButton,
    createZYFStyleTimeline,
    createZYFStyleCropOverlay,
    setWidgetHidden,
    zyf_fitHeight,
    enableHiddenTypeToggle,
} from "../VideoPlayer/videoPlayer.js";

// Per-format CRF defaults. H264 = 19, H265 = 22 (CPU encoders, libx264 /
// libx265). We surface a single user-facing "crf" widget whose default
// is swapped automatically when the user toggles the format dropdown.
const DEFAULT_CRF_BY_FORMAT = {
    H264: 19,
    H265: 22,
};

function findWidget(node, name) {
    if (!node?.widgets) return undefined;
    return node.widgets.find((w) => w?.name === name);
}

// --- Small DOM helpers -----------------------------------------------------

/**
 * 从 videoInfo 对象构建 params 并更新自定义预览。
 * videoInfo 来自 Python 端 ui.images[0] 或 nodeOutputs.images[0]，
 * 包含 filename/type/subfolder/frame_rate/total_frames 等字段。
 * @param {object} preview - attachZYFStylePreview 返回的预览对象
 * @param {object} videoInfo - 视频信息对象
 */
function applyVideoInfoToPreview(preview, videoInfo) {
    if (!preview || !videoInfo?.filename) return;
    try {
        const params = {
            filename: videoInfo.filename,
            type: videoInfo.type || "output",
            subfolder: videoInfo.subfolder || "",
            format: videoInfo.format || "video/mp4",
            frame_rate: Number(videoInfo.frame_rate) || 30,
            total_frames: Math.max(1, Number(videoInfo.total_frames) || 1),
            width: Number(videoInfo.width) || 0,
            height: Number(videoInfo.height) || 0,
            duration: Number(videoInfo.duration) || 0,
        };
        const cur = preview.widget?.value?.params;
        // 如果文件名和类型都相同，说明是同一个视频，不重复加载（避免闪烁）
        if (cur && cur.filename === params.filename &&
            cur.type === params.type && cur.subfolder === params.subfolder) {
            return;
        }
        preview.widget.value = { hidden: false, paused: false, params };
        preview.updateSource?.();
    } catch (err) {
        console.warn("[zyf-video] applyVideoInfoToPreview failed:", err);
    }
}

/**
 * 从 app.nodeOutputs 中提取此节点的视频信息。
 * 当节点在后台执行完成时（用户切换了工作流tab），onExecuted 不会被调用，
 * 但 setNodeOutputsByExecutionId 已经把数据写入了全局 nodeOutputs。
 * @param {object} node - LiteGraph 节点实例
 * @returns {object|null} videoInfo 或 null
 */
function extractVideoInfoFromNodeOutputs(node) {
    try {
        const nodeId = String(node.id);
        const out = app.nodeOutputs?.[nodeId];
        if (!out) return null;
        const isAnimated = Array.isArray(out.animated) ? out.animated.some(Boolean) : false;
        if (!isAnimated) return null;
        if (!Array.isArray(out.images) || out.images.length === 0) return null;
        const videoInfo = out.images[0];
        if (!videoInfo?.filename) return null;
        // 检查是否是视频文件（不是 webp/png 动图）
        const fn = (videoInfo.filename || "").toLowerCase();
        if (fn.endsWith(".webp") || fn.endsWith(".png")) return null;
        return videoInfo;
    } catch (e) {
        return null;
    }
}

/**
 * 原地清空 nodeOutputs 中此节点的视频/动画输出数据，
 * 防止 ComfyUI 原生 onDrawBackground 创建原生预览 widget。
 * 使用原地修改（不创建新数组引用）避免 updatePreviews 误判变化。
 * @param {object} node - LiteGraph 节点实例
 */
function clearNodeOutputsVideoData(node) {
    try {
        const nodeId = String(node.id);
        const out = app.nodeOutputs?.[nodeId];
        if (!out) return;
        if (out.animated?.length) {
            for (let i = 0; i < out.animated.length; i++) out.animated[i] = false;
        }
        if (Array.isArray(out.images)) {
            out.images.length = 0;
        }
    } catch (e) {}
}

/**
 * 2026-07-28: 清理节点上所有非 zyf 自定义的原生预览 widget。
 *
 * ComfyUI 有两条原生预览创建路径：
 * 1. useNodeAnimatedImage().showAnimatedPreview()：
 *    - 创建 name="$$comfy_animation_preview" (ANIM_PREVIEW_WIDGET), type="img" 的 widget
 *    - 由 isAnimatedOutput() 触发（检测 animated 数组中有 true 值）
 * 2. useNodeVideo().showPreview()：
 *    - 创建 name="video-preview", type="video" 的 widget
 *    - 由 isVideoOutput() 触发（animated 且文件不是 webp/png）
 *
 * 旧代码误判为 type === "preview"，完全匹配错了，导致清理无效。
 * 此函数在 onNodeCreated、onExecuted、configure、onDrawBackground、onDrawForeground
 * 中都会被调用，形成多层防护。
 *
 * @param {object} node - LiteGraph 节点实例
 * @param {object} customPreviewWidget - 我们的自定义预览 widget（不会被移除）
 */
function cleanupNativePreviewWidgets(node, customPreviewWidget) {
    if (!node?.widgets?.length) return;
    // 要识别的原生预览 widget name 集合
    const nativeNames = new Set([
        "video-preview",                         // useNodeVideo 创建的视频预览
        "$$comfy_animation_preview",             // useNodeAnimatedImage 创建的动画预览
    ]);
    if (typeof ANIM_PREVIEW_WIDGET === "string" && ANIM_PREVIEW_WIDGET &&
        !nativeNames.has(ANIM_PREVIEW_WIDGET)) {
        nativeNames.add(ANIM_PREVIEW_WIDGET);
    }
    const toRemove = node.widgets.filter(
        (w) => w && w !== customPreviewWidget &&
               (nativeNames.has(w.name) || w.type === "preview" || w.type === "video")
    );
    if (!toRemove.length) return;
    for (const pw of toRemove) {
        try {
            const idx = node.widgets.indexOf(pw);
            if (idx !== -1) node.widgets.splice(idx, 1);
        } catch (e) {}
        try { pw.onRemove?.(); } catch (e) {}
        try { pw.element?.remove?.(); } catch (e) {}
    }
    // 清除 videoContainer 引用，防止 useNodeVideo 再次替换子元素
    // （原生 useNodeVideo 通过检查 videoContainer 是否存在来决定是否复用）
    try {
        if (node.videoContainer) {
            node.videoContainer = undefined;
        }
    } catch (e) {}
    // 清除 previewMediaType，防止 isVideoNode() 返回 true
    try {
        if (node.previewMediaType === "video") {
            node.previewMediaType = undefined;
        }
    } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

function setWidgetValue(widget, value) {
    if (!widget) {
        return;
    }
    widget.value = value;
    if (widget.inputEl && "value" in widget.inputEl) {
        widget.inputEl.value = value;
    }
    if (widget.input && "value" in widget.input) {
        widget.input.value = value;
    }
    if (widget.el && "value" in widget.el) {
        widget.el.value = value;
    }
    if (widget.element && "value" in widget.element) {
        widget.element.value = value;
    }
}

// --- zyf 风格视频预览 ------------------------------------------------------
function attachZYFStylePreview(node) {
    if (node._zyfSaverPreviewAttached) {
        return node._zyfSaverPreview;
    }
    node._zyfSaverPreviewAttached = true;

    // 2026-07-21: 使用自定义 "zyf_video_preview" 类型。
    // 之前尝试 "preview"（ComfyUI 保留类型）导致 addDOMWidget 与
    // 内部机制冲突，节点创建失败（搜得到但点击打不开）。
    const element = document.createElement("div");
    element.className = "zyf-preview-wrap";
    element.setAttribute("data-zyf-preview", "1");
    element.style.position = "relative";
    element.style.overflow = "hidden";
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.background = "#000";
    const previewWidget = node.addDOMWidget("video_preview_widget", "zyf_video_preview", element, {
        serialize: true,
        hideOnZoom: false,
        getValue() { return element.value; },
        setValue(v) {
            element.value = v;
            // 2026-07-21: serialize:true 让 video_info 保存到工作流 JSON。
            // 切换页面回来时 ComfyUI 通过 configure() → setValue() 恢复值，
            // 此时自动触发 updateSource 重新加载视频。
            if (v?.params?.filename) {
                try { previewWidget.updateSource?.(); } catch (err) {}
            }
        },
    });
    previewWidget.value = { hidden: false, paused: false, params: {} };
    previewWidget._hasVideo = false;
    // 不设内联高度，由 LiteGraph 通过 computeSize 管理，避免与框架布局冲突。
    previewWidget.computeSize = function (width) {
        if (!this._hasVideo) {
            this.computedHeight = 60;
            return [width, 60];
        }
        let h = 0;
        // 使用 node.size[0] 获取实际节点宽度，而不是 LiteGraph 传入的缓存宽度。
        const actualWidth = node.size?.[0] || width;
        if (this.aspectRatio && this.aspectRatio > 0 && actualWidth > 0) {
            h = actualWidth / this.aspectRatio;
        }
        this.computedHeight = h;
        return [width, Math.max(0, h)];
    };
    previewWidget.aspectRatio = 16 / 9;

    // 2026-07-21: ResizeObserver 监听 element 宽度变化，触发 node.computeSize()
    // 同步 LiteGraph 节点布局。不设内联高度，完全由 computeSize 返回值管理。
    const previewResizeObserver = new ResizeObserver(() => {
        if (!previewWidget._hasVideo) return;
        if (typeof node.computeSize === "function") {
            node.computeSize();
        }
        if (node.setDirtyCanvas) {
            node.setDirtyCanvas(true, true);
        }
    });
    previewResizeObserver.observe(element);

    const inner = document.createElement("div");
    inner.style.position = "relative";
    inner.style.width = "100%";
    inner.style.height = "100%";
    element.appendChild(inner);

    const videoEl = document.createElement("video");
    videoEl.controls = false;
    videoEl.loop = true;
    videoEl.muted = false;
    videoEl.playsInline = true;
    videoEl.style.width = "100%";
    videoEl.style.height = "100%";
    videoEl.style.objectFit = "fill";
    videoEl.style.backgroundColor = "#000";
    videoEl.style.display = "block";
    videoEl.style.pointerEvents = "none";
    inner.appendChild(videoEl);

    // ---- 裁剪状态(内存存储,不依赖 widgets) --------------------------------
    const cropState = { cx: 0, cy: 0, cw: 1, ch: 1 };
    const getCropState = () => ({ ...cropState });
    const setCropState = (cx, cy, cw, ch) => {
        cropState.cx = cx;
        cropState.cy = cy;
        cropState.cw = cw;
        cropState.ch = ch;
    };

    // ---- 自由裁剪 overlay(完整移植自加载视频) ------------------------------
    const setAudioSuppressed = (suppressed) => {
        const acEl = audioControl?.element;
        if (!acEl) return;
        if (!acEl.style.transition) {
            acEl.style.transition = "opacity 0.15s ease";
        }
        if (suppressed) {
            acEl.style.pointerEvents = "none";
            acEl.style.opacity = "0.25";
            acEl.setAttribute("aria-hidden", "true");
        } else {
            acEl.style.pointerEvents = "auto";
            acEl.style.opacity = "";
            acEl.removeAttribute("aria-hidden");
        }
    };
    // 2026-07-21: 保存视频使用 object-fit: fill（视频拉伸铺满容器），
    // 默认 getRenderedVideoRect 用 contain 假设（计算黑边），会导致
    // 裁剪框只覆盖视频实际显示区域而不是整个预览容器。这里把预览内
    // 容区尺寸告知 cropOverlay，让它把 videoEl 视为完全填充。
    const cropOverlay = createZYFStyleCropOverlay(inner, videoEl, {
        getCropState,
        setCropState,
        getOutputPixelSize: () => ({
            w: videoEl.videoWidth || 0,
            h: videoEl.videoHeight || 0,
        }),
        getRenderedVideoRect: () => {
            const cw = videoEl.clientWidth;
            const ch = videoEl.clientHeight;
            if (cw <= 0 || ch <= 0) return null;
            // object-fit: fill 模式下 videoEl 像素完全填充容器，无黑边
            return { x: 0, y: 0, w: cw, h: ch };
        },
        onVisibilityChange: (visible) => {
            // 与加载视频一致：裁剪编辑器打开时屏蔽音频控件
            setAudioSuppressed(visible);
        },
    });

    // ---- 截屏按钮(左上角,支持裁剪) ----------------------------------------
    const screenshotBtn = createZYFStyleScreenshotButton(inner, () => videoEl);
    // 重写截屏逻辑:如果有裁剪,只截裁剪区域
    const origScreenshotClick = screenshotBtn.onclick;
    screenshotBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const vw = videoEl.videoWidth || 0;
        const vh = videoEl.videoHeight || 0;
        if (!vw || !vh || videoEl.readyState < 2) return;
        const crop = cropOverlay.getCropForScreenshot();
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (crop) {
            sx = Math.round(crop.cx * vw);
            sy = Math.round(crop.cy * vh);
            sw = Math.round(crop.cw * vw);
            sh = Math.round(crop.ch * vh);
            if (sx < 0) { sw += sx; sx = 0; }
            if (sy < 0) { sh += sy; sy = 0; }
            if (sx + sw > vw) sw = vw - sx;
            if (sy + sh > vh) sh = vh - sy;
            if (sw <= 0 || sh <= 0) return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, sw, sh);
        canvas.toBlob((blob) => {
            if (!blob) return;
            try {
                navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]).then(() => {
                    screenshotBtn.classList.add("zyf-screenshot-btn--success");
                    setTimeout(() => screenshotBtn.classList.remove("zyf-screenshot-btn--success"), 600);
                }).catch(() => {});
            } catch (err) {}
        }, "image/png");
    }, true);

    // ---- 音频控件(直接控制 videoEl 的音量/静音) ------------------------
    const audioControl = createZYFStyleAudioControl(inner, () => videoEl);

    // ---- 进度条 -----------------------------------------------------------
    const timeline = createZYFStyleTimeline(node);

    // ---- 播放/暂停 click overlay -----------------------------------------
    const playPauseOverlay = document.createElement("div");
    playPauseOverlay.style.position = "absolute";
    playPauseOverlay.style.inset = "0";
    playPauseOverlay.style.zIndex = "100";
    playPauseOverlay.style.cursor = "default";
    playPauseOverlay.style.pointerEvents = "auto";
    playPauseOverlay.addEventListener("click", (e) => {
        if (cropOverlay.isVisible()) return;
        e.preventDefault();
        e.stopPropagation();
        if (videoEl.paused || videoEl.ended) {
            try { videoEl.play(); } catch (err) {}
        } else {
            try { videoEl.pause(); } catch (err) {}
        }
    });
    inner.appendChild(playPauseOverlay);

    // 裁剪编辑器打开时禁用 playPause overlay（音频控件由 cropOverlay 的
    // onVisibilityChange 回调处理，避免重写 setVisible 错过内部调用）
    cropOverlay.setVisible = ((orig) => (visible) => {
        orig.call(cropOverlay, visible);
        playPauseOverlay.style.pointerEvents = visible ? "none" : "auto";
        playPauseOverlay.style.zIndex = visible ? "0" : "100";
    })(cropOverlay.setVisible);

    // ---- 视频源就绪 -------------------------------------------------------
    let pendingMeta = { frameRate: 30, totalFrames: 1 };
    const onLoadedMetadata = () => {
        const ar = (videoEl.videoWidth && videoEl.videoHeight)
            ? videoEl.videoWidth / videoEl.videoHeight
            : 16 / 9;
        previewWidget.aspectRatio = ar;
        previewWidget._hasVideo = true;
        // 触发 LiteGraph 重新计算节点布局，高度由 computeSize 管理。
        if (typeof node.computeSize === "function") {
            node.computeSize();
        }
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
        audioControl.applyToAudio();
        timeline.attach(videoEl, pendingMeta);
        cropOverlay.refresh();
    };
    videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
    videoEl.addEventListener("durationchange", onLoadedMetadata);

    // 2026-07-21: 文件被删除 / 路径失效时 videoEl 触发 error 事件，
    // 此时必须收回 _hasVideo 标志、清空 src、强制节点高度回到基础高度
    // （无视频状态），否则用户看到一个巨大的黑框。VHS 合并视频插件
    // 就是这样：删了文件高度立刻回收，文件恢复又自动显示。
    const onVideoError = () => {
        if (!previewWidget._hasVideo) return;
        previewWidget._hasVideo = false;
        try { videoEl.removeAttribute("src"); } catch (err) {}
        try { videoEl.load(); } catch (err) {}
        if (typeof node.computeSize === "function") {
            node.computeSize();
        }
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
        // 标记：视频刚消失，允许 retryLoad 下一次高度检查时强制回收
        node._zyfSaverNoVideoHeightSet = false;
        // 主动把节点高度收回基础高度（无视频状态）。
        // 双重 rAF 等 LiteGraph 完成 computeSize 后再 setSize，避免覆盖。
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                try {
                    let baseH = 30;
                    for (const w of node.widgets ?? []) {
                        if (w.computeSize) {
                            const sz = w.computeSize(node.size?.[0] ?? 200);
                            if (Array.isArray(sz) && typeof sz[1] === "number") {
                                baseH += sz[1] + 4;
                            }
                        } else {
                            baseH += 24;
                        }
                    }
                    if (node.size && node.size[1] > baseH + 10) {
                        node.setSize([node.size[0], baseH]);
                    }
                } catch (err) {}
            });
        });
    };
    videoEl.addEventListener("error", onVideoError);
    videoEl.addEventListener("emptied", onVideoError);

    // ---- API --------------------------------------------------------------
    // 2026-07-21: 从 previewWidget.value.params 读取视频信息，与 loader 一致。
    const resolveVideoUrl = (params) => {
        if (!params) return null;
        const filename = params.filename;
        if (!filename) return null;
        const type = params.type || "output";
        const ts = Date.now();
        const sub = params.subfolder ? `&subfolder=${encodeURIComponent(params.subfolder)}` : "";
        return `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}${sub}&t=${ts}`;
    };

    const updateSource = () => {
        const params = previewWidget.value?.params;
        if (!params) return;
        const url = resolveVideoUrl(params);
        if (!url) return;
        const fr = Number(params.frame_rate) || 30;
        const total = Math.max(1, Number(params.total_frames) || 1);
        pendingMeta = { frameRate: fr, totalFrames: total };
        // 2026-07-21: 如果 videoEl 之前因为 error 收回了 src，但参数没变
        // （用户恢复了文件），强制重新赋值并 load，触发重新加载。
        if (videoEl.src !== url || !previewWidget._hasVideo) {
            videoEl.src = url;
            try { videoEl.load(); } catch (err) {}
        }
    };
    previewWidget.updateSource = updateSource;

    const clearSource = () => {
        try { videoEl.pause(); } catch (err) {}
        try { videoEl.removeAttribute("src"); videoEl.load(); } catch (err) {}
        previewWidget._hasVideo = false;
        // 标记：视频刚消失，允许 retryLoad 下一次高度检查时强制回收
        node._zyfSaverNoVideoHeightSet = false;
        // 触发 LiteGraph 重新计算节点布局，高度由 computeSize 管理。
        if (typeof node.computeSize === "function") {
            node.computeSize();
        }
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
    };

    const api = {
        widget: previewWidget,
        element,
        videoEl,
        timeline,
        cropOverlay,
        updateSource,
        clearSource,
    };
    node._zyfSaverPreview = api;
    return api;
}

// --- Node registration -----------------------------------------------------

export function isVideoSaverNode(node) {
    if (!node) {
        return false;
    }
    const comfyClass = node.comfyClass ?? "";
    const type = node.type ?? "";
    return comfyClass.includes("ZyfVideoSaver")
        || comfyClass.includes("zyf保存视频")
        || type.includes("ZyfVideoSaver");
}

export async function createVideoSaverWidgets(nodeType) {
    console.log("[zyf-video] createVideoSaverWidgets called", {
        comfyClass: nodeType?.comfyClass,
        nodeDataName: nodeType?.nodeData?.name,
    });
    if (nodeType?.prototype?._zyfVideoSaverPatched) {
        console.log("[zyf-video] already patched, returning");
        return;
    }
    nodeType.prototype._zyfVideoSaverPatched = true;

    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        console.log("[zyf-video] onNodeCreated for", this.comfyClass);
        originalNodeCreated?.apply(this, arguments);

        const formatWidget = findWidget(this, "编码格式");
        const crfWidget = findWidget(this, "质量CRF");

        if (crfWidget) {
            this._zyfUserSetCrf = crfWidget.value;
        }

        const updateCrfForFormat = (format) => {
            if (!crfWidget) {
                return;
            }
            const newDefault = DEFAULT_CRF_BY_FORMAT[format] ?? 19;
            const knownDefaults = new Set(Object.values(DEFAULT_CRF_BY_FORMAT));
            if (knownDefaults.has(crfWidget.value)) {
                setWidgetValue(crfWidget, newDefault);
                this._zyfUserSetCrf = newDefault;
            }
        };

        if (formatWidget) {
            const originalFormatCallback = formatWidget.callback;
            formatWidget.callback = (value) => {
                originalFormatCallback?.(value);
                updateCrfForFormat(value);
            };
        }

        if (crfWidget && !crfWidget._zyfSaverCrfWatch) {
            const originalCrfCallback = crfWidget.callback;
            crfWidget.callback = (value) => {
                this._zyfUserSetCrf = value;
                originalCrfCallback?.(value);
            };
            crfWidget._zyfSaverCrfWatch = true;
        }

        applyZyfTooltips(this);

        // ========== 顶部工具栏(折叠/展开按钮) ==========
        // 与 zyf加载视频 保持一致:右上角 chevron,默认折叠
        // 可折叠 widgets:所有参数widget(帧率/文件名前缀/输出模式/保存元数据/保留临时文件/编码格式/质量CRF)
        // 预览widget 始终可见
        const fpsW = findWidget(this, "帧率");
        const prefixW = findWidget(this, "文件名前缀");
        const modeW = findWidget(this, "输出模式");
        const metaW = findWidget(this, "保存元数据");
        const keepTempW = findWidget(this, "保留临时文件");
        const formatW = findWidget(this, "编码格式");
        const crfW = findWidget(this, "质量CRF");
        const collapsibleSaverWidgets = [
            fpsW, prefixW, modeW, metaW, keepTempW, formatW, crfW,
        ].filter(Boolean);

        // 折叠状态:默认折叠,从 node.properties 恢复
        this._zyfSaverParamsCollapsed = this.properties?._zyfSaverParamsCollapsed !== false;
        const persistSaverCollapsed = (collapsed) => {
            this._zyfSaverParamsCollapsed = !!collapsed;
            try {
                if (!this.properties) this.properties = {};
                this.properties._zyfSaverParamsCollapsed = this._zyfSaverParamsCollapsed;
            } catch (e) {}
        };

        const CHEVRON_DOWN_SVG = `<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>`;
        const CHEVRON_UP_SVG = `<svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>`;

        const saverToolbarEl = document.createElement("div");
        saverToolbarEl.className = "zyf-top-toolbar";
        // 右侧弹性占位 + chevron 按钮
        const saverSpacer = document.createElement("div");
        saverSpacer.style.flex = "1";
        const saverToggleBtn = document.createElement("button");
        saverToggleBtn.type = "button";
        saverToggleBtn.className = "zyf-toolbar-btn zyf-toggle-btn";
        saverToggleBtn.title = "展开参数设置";
        saverToggleBtn.innerHTML = CHEVRON_DOWN_SVG;
        saverToolbarEl.appendChild(saverSpacer);
        saverToolbarEl.appendChild(saverToggleBtn);

        const saverToolbarWidget = this.addDOMWidget("zyf_saver_top_toolbar", "saver_top_toolbar", saverToolbarEl, {
            serialize: false,
            hideOnZoom: false,
        });
        saverToolbarWidget.computeSize = function(width) {
            return [width, 26];
        };
        // 将工具栏放到最顶部
        if (this.widgets && this.widgets.length > 0) {
            const first = this.widgets[0];
            if (first !== saverToolbarWidget) {
                const idx = this.widgets.indexOf(saverToolbarWidget);
                if (idx > 0) this.widgets.splice(idx, 1);
                this.widgets.unshift(saverToolbarWidget);
            }
        }

        const setSaverGroupVisible = (widgets, visible) => {
            for (const w of widgets) {
                if (!w) continue;
                setWidgetHidden(w, !visible);
            }
        };

        const applySaverCollapseState = () => {
            const collapsed = this._zyfSaverParamsCollapsed;
            if (collapsed) {
                setSaverGroupVisible(collapsibleSaverWidgets, false);
                saverToggleBtn.innerHTML = CHEVRON_DOWN_SVG;
                saverToggleBtn.title = "展开参数设置";
                saverToggleBtn.classList.remove("active");
            } else {
                setSaverGroupVisible(collapsibleSaverWidgets, true);
                saverToggleBtn.innerHTML = CHEVRON_UP_SVG;
                saverToggleBtn.title = "折叠参数设置";
                saverToggleBtn.classList.add("active");
            }
            zyf_fitHeight(this);
        };

        saverToggleBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        saverToggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            persistSaverCollapsed(!this._zyfSaverParamsCollapsed);
            applySaverCollapseState();
        });

        this._zyfSaverTopToolbar = {
            widget: saverToolbarWidget,
            toggleBtn: saverToggleBtn,
            collapsibleWidgets: collapsibleSaverWidgets,
            applyCollapseState: applySaverCollapseState,
        };

        // 初始状态:折叠
        // 立即设置widget.hidden标记(LiteGraph创建DOM时会读取此标记加"litegraph-hidden"类),
        // 防止初次创建节点时参数闪现。
        if (this._zyfSaverParamsCollapsed) {
            for (const w of collapsibleSaverWidgets) {
                if (!w) continue;
                enableHiddenTypeToggle(w);
                w.hidden = true;
            }
        }
        applySaverCollapseState();
        // rAF 后再补一次:确保widget DOM已创建,display:none能正确应用
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.removed) return;
                applySaverCollapseState();
            });
        });

        const preview = attachZYFStylePreview(this);
        this._zyfSaverPreview = preview;

        // 立即清理节点创建时可能已存在的原生预览 widget
        cleanupNativePreviewWidgets(this, preview.widget);

        // 劫持 onExecuted：提取视频信息更新自定义预览，清空 message 参数，
        // 但不在这里清空 nodeOutputs——交给 onDrawBackground 统一处理，
        // 因为后台执行完成时 onExecuted 不会被调用（节点不在当前rootGraph），
        // 只有 onDrawBackground 能在切回工作流时从 nodeOutputs 提取数据。
        const originalOnExecuted = this.onExecuted;
        this.onExecuted = function (message) {
            const animatedTuple = message?.animated;
            const isAnimated = Array.isArray(animatedTuple) ? animatedTuple[0] : false;
            const images = message?.images;
            let videoInfo = null;
            if (isAnimated && Array.isArray(images) && images.length > 0) {
                videoInfo = images[0];
                // 清空 message 上的 images/animated，防止原始 handler 产生副作用
                message.images = [];
                message.animated = [false];
            }
            originalOnExecuted?.apply(this, arguments);
            cleanupNativePreviewWidgets(this, preview.widget);
            // 立即更新自定义预览（前台执行场景）
            if (videoInfo) {
                applyVideoInfoToPreview(preview, videoInfo);
            }
        };

        // 覆盖 onDrawBackground：这是核心拦截点。
        // 关键流程：
        //   1. 先从 app.nodeOutputs 提取视频信息（后台执行完成时 onExecuted 不会
        //      被调用，但 setNodeOutputsByExecutionId 已经把数据写入 nodeOutputs）
        //   2. 清除节点上的原生视频预览标记（videoContainer/previewMediaType），
        //      防止 isVideoNode() 返回 true 导致原生预览创建
        //   3. 用提取的视频信息更新自定义预览（去重：相同文件不重复加载）
        //   4. 清空 nodeOutputs，让原生 updatePreviews() 中 isVideoOutput() 返回 false
        //   5. 调用原始 onDrawBackground（此时原生预览不会被创建）
        //   6. 防御性清理可能残留的原生预览 widget
        const origOnDrawBackground = this.onDrawBackground;
        this.onDrawBackground = function (ctx, canvas) {
            // 第一步：从 nodeOutputs 提取视频信息（在清空之前！）
            const videoInfo = extractVideoInfoFromNodeOutputs(this);
            // 第二步：清除原生预览状态标记，让 isVideoNode() 返回 false
            try { this.videoContainer = undefined; } catch (e) {}
            try {
                if (this.previewMediaType === "video") this.previewMediaType = undefined;
            } catch (e) {}
            // 第三步：更新自定义预览
            if (videoInfo) {
                applyVideoInfoToPreview(preview, videoInfo);
            }
            // 第四步：清空 nodeOutputs，防止 isVideoOutput() 返回 true
            clearNodeOutputsVideoData(this);
            // 第五步：调用原始 onDrawBackground
            origOnDrawBackground?.apply(this, arguments);
            // 第六步：防御性清理原生 widget
            cleanupNativePreviewWidgets(this, preview.widget);
        };

        // 同样覆盖 onDrawForeground 以防万一
        const origOnDrawForeground = this.onDrawForeground;
        this.onDrawForeground = function (ctx, canvas) {
            origOnDrawForeground?.apply(this, arguments);
            cleanupNativePreviewWidgets(this, preview.widget);
        };

        // 覆盖 configure()：工作流加载恢复节点状态后，延迟一帧确保
        // 原生 configure 的副作用完成，然后清理原生预览 widget。
        // nodeOutputs 由 onDrawBackground 统一处理，不需要在这里清空。
        const origConfigure = this.configure;
        this.configure = function (data) {
            origConfigure?.call(this, data);
            requestAnimationFrame(() => {
                cleanupNativePreviewWidgets(this, preview.widget);
                // 恢复折叠/展开状态:优先从 properties 读取持久化值,默认折叠
                if (this._zyfSaverTopToolbar) {
                    const saved = data?.properties?._zyfSaverParamsCollapsed;
                    this._zyfSaverParamsCollapsed = saved === undefined ? true : !!saved;
                    try {
                        if (!this.properties) this.properties = {};
                        this.properties._zyfSaverParamsCollapsed = this._zyfSaverParamsCollapsed;
                    } catch (e) {}
                    this._zyfSaverTopToolbar.applyCollapseState();
                }
            });
        };

        const computeBaseHeight = () => {
            let h = 30;
            for (const w of this.widgets ?? []) {
                // 跳过被折叠隐藏的 widget (type 被劫持为 "hidden" 或显式 hidden 标记)
                if (w.hidden || w.type === "hidden") continue;
                if (w.computeSize) {
                    try {
                        const sz = w.computeSize(this.size?.[0] ?? 200);
                        if (Array.isArray(sz) && typeof sz[1] === "number") {
                            h += sz[1] + 4;
                        }
                    } catch (e) {}
                } else {
                    h += 24;
                }
            }
            return h;
        };

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const baseHeight = computeBaseHeight();
                if (this.size && this.size[1] > baseHeight + 10) {
                    const previewHasVideo = !!(this._zyfSaverPreview?.videoEl?.src);
                    if (!previewHasVideo) {
                        this.setSize([this.size[0], baseHeight]);
                    }
                }
            });
        });
        // 2026-07-25: 双重 rAF 可能跑在 LiteGraph 恢复节点尺寸之前（尤其是
        // "仅预览"模式 temp 文件重启后丢失、params 为空的情况）。追加一个
        // setTimeout 延迟检查，确保最终高度正确。
        setTimeout(() => {
            if (this.removed || this._isDestroyed) return;
            const baseH = computeBaseHeight();
            if (this.size && this.size[1] > baseH + 10) {
                const previewHasVideo = !!(this._zyfSaverPreview?.videoEl?.src);
                if (!previewHasVideo) {
                    this.setSize([this.size[0], baseH]);
                }
            }
        }, 300);

        // 2026-07-21: 用 HEAD 请求轮询检测视频文件是否存在。
        // 不能用 <video> 的 error 事件 —— 视频先加载成功后文件被外部删除，
        // 浏览器不会触发任何事件，videoEl 就卡在最后一帧、节点高度不变。
        // 用 fetch HEAD 是最轻量的方式，不下载数据，只检查 HTTP 状态码。
        // 文件存在 → 若之前被折叠则自动恢复；文件不存在 → 立即折叠。
        const collapsePreview = () => {
            const p = this._zyfSaverPreview;
            if (!p) return;
            const w = p.widget;
            if (!w?._hasVideo) return;
            w._hasVideo = false;
            try { p.videoEl?.removeAttribute("src"); } catch (err) {}
            try { p.videoEl?.load(); } catch (err) {}
            if (typeof this.computeSize === "function") {
                this.computeSize();
            }
            if (this.setDirtyCanvas) this.setDirtyCanvas(true, true);
            // 标记：视频刚消失，需要在下一次高度检查时强制回收
            this._zyfSaverNoVideoHeightSet = false;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    try {
                        const baseH = computeBaseHeight();
                        if (this.size && this.size[1] > baseH + 10) {
                            this.setSize([this.size[0], baseH]);
                        }
                    } catch (err) {}
                });
            });
        };

        const retryLoad = () => {
            if (this.removed || this._isDestroyed) return;
            const w = this._zyfSaverPreview?.widget;
            const v = w?.value;
            if (!v?.params?.filename) {
                // 2026-07-25: "仅预览"模式下 params 为空（temp 文件重启后丢失），
                // 但节点高度可能仍保持视频预览时的展开高度。检查是否需要回收。
                if (w?._hasVideo) {
                    collapsePreview();
                } else if (!this._zyfSaverNoVideoHeightSet) {
                    // 首次检测到无视频状态，强制回收高度。之后不再重复 setSize，
                    // 避免每秒一次的高度振荡（LiteGraph 的 computeSize 与
                    // computeBaseHeight 可能有微小差异，反复 setSize 会造成闪动）。
                    const baseH = computeBaseHeight();
                    if (this.size && this.size[1] > baseH + 10) {
                        this.setSize([this.size[0], baseH]);
                    }
                    this._zyfSaverNoVideoHeightSet = true;
                }
                this._zyfSaverRetryTimer = setTimeout(retryLoad, 1000);
                return;
            }
            // 视频文件存在，清除无视频标记
            this._zyfSaverNoVideoHeightSet = false;
            const params = v.params;
            const filename = params.filename;
            const type = params.type || "output";
            const sub = params.subfolder ? `&subfolder=${encodeURIComponent(params.subfolder)}` : "";
            const url = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}${sub}&t=${Date.now()}`;

            fetch(url, { method: "HEAD", cache: "no-cache" })
                .then((resp) => {
                    if (resp.ok) {
                        // 文件存在 —— 若之前因为文件缺失被折叠，现在恢复
                        if (!w._hasVideo) {
                            try { this._zyfSaverPreview?.updateSource?.(); } catch (err) {}
                        }
                    } else {
                        // 文件不存在 —— 折叠
                        collapsePreview();
                    }
                })
                .catch(() => {
                    // 网络错误等同于文件不存在
                    collapsePreview();
                })
                .finally(() => {
                    this._zyfSaverRetryTimer = setTimeout(retryLoad, 1000);
                });
        };
        // 清理可能存在的旧 timer（重新创建节点时）
        if (this._zyfSaverRetryTimer) {
            clearTimeout(this._zyfSaverRetryTimer);
        }
        this._zyfSaverRetryTimer = setTimeout(retryLoad, 500);
    };
}

// --- 同步播放 ---------------------------------------------------------------
export function addSyncPlayMenuOptions(nodeType) {
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = origOnNodeCreated?.apply(this, arguments);

        const orig = this.getExtraMenuOptions;
        this.getExtraMenuOptions = function (canvas, options) {
            if (orig) {
                orig.apply(this, arguments);
            }

            const hasExisting = options.length > 0 && options[0] != null;
            options.unshift({
                content: "Sync preview",
                callback: () => {
                    // 查找加载视频节点，读取其开始帧/结束帧区间
                    const loaderNodes = (app?.graph?._nodes ?? []).filter(
                        (n) => (n.comfyClass ?? "").includes("zyf加载视频") || (n.comfyClass ?? "").includes("ZyfVideoLoader")
                    );
                    const loaderNode = loaderNodes[0];
                    let startTime = 0;
                    let endTime = null;

                    // 找到加载视频节点的 <video> 元素，以便区分处理
                    let loaderVideo = null;
                    if (loaderNode) {
                        for (const w of loaderNode.widgets ?? []) {
                            if (w._videoEl && w._videoEl.tagName === "VIDEO") {
                                loaderVideo = w._videoEl;
                                break;
                            }
                        }
                    }

                    if (loaderNode?._zyfFrameState) {
                        const state = loaderNode._zyfFrameState;
                        const inPoint = state.inPoint || 1;
                        const outPoint = state.outPoint || state.totalFrames || 1;
                        const frameRate = state.frameRate || 30;
                        startTime = (inPoint - 1) / frameRate;
                        endTime = outPoint / frameRate;
                    }

                    const videos = document.querySelectorAll('[data-zyf-preview] video');
                    for (const video of videos) {
                        if (!video.src) continue;
                        // 移除上一次同步预览的循环监听
                        if (video._zyfSyncCleanup) {
                            video._zyfSyncCleanup();
                            video._zyfSyncCleanup = null;
                        }

                        const isLoaderVideo = (video === loaderVideo);
                        // 加载视频：从开始帧播放，在区间内循环
                        // 保存视频：从 0 开始播放（输出视频本身就是截取后的结果）
                        const vStartTime = isLoaderVideo ? startTime : 0;
                        video.muted = true;
                        video.currentTime = vStartTime;
                        video.play();

                        if (isLoaderVideo && endTime !== null && endTime > startTime) {
                            const onTimeUpdate = () => {
                                if (video.currentTime >= endTime) {
                                    video.currentTime = startTime;
                                }
                            };
                            const onPause = () => {
                                video.removeEventListener("timeupdate", onTimeUpdate);
                                video.removeEventListener("pause", onPause);
                                video._zyfSyncCleanup = null;
                            };
                            video.addEventListener("timeupdate", onTimeUpdate);
                            video.addEventListener("pause", onPause);
                            video._zyfSyncCleanup = () => {
                                video.removeEventListener("timeupdate", onTimeUpdate);
                                video.removeEventListener("pause", onPause);
                            };
                        }
                    }
                },
            });
            if (hasExisting) {
                options.splice(1, 0, null);
            }
        };

        return result;
    };
}