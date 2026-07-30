import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { createVideoLoaderWidgets } from "./VideoPlayer/videoPlayer.js";
import { addSyncPlayMenuOptions as addSyncPlayLoader } from "./VideoPlayer/videoPlayer.js";
import { createVideoSaverWidgets, isVideoSaverNode } from "./VideoSaver/videoSaver.js";
import { addSyncPlayMenuOptions as addSyncPlaySaver } from "./VideoSaver/videoSaver.js";
import { registerGroupExtensions, setupConfigAndSerialization } from "./EnhancedGroups/enhancedGroups.js";

import { zyfAddStylesheet, zyfGetUrl, applyZyfTooltips } from "./utils.js";
import { isVideoLoaderNode } from "./VideoPlayer/videoPlayer.js";

function isInputConnected(node, name) {
    const inputs = node?.inputs || [];
    const inputIndex = inputs.findIndex((entry) => entry?.name === name);
    if (inputIndex === -1) {
        return false;
    }
    const input = inputs[inputIndex];
    if (input.link !== null && input.link !== undefined) {
        return true;
    }
    if (Array.isArray(input.links) && input.links.length) {
        return true;
    }
    return false;
}

function getWidgetValue(node, name, fallback = null) {
    const widget = node.widgets?.find((w) => w.name === name);
    return widget ? widget.value : fallback;
}

function computeVideoLoaderSignature(node) {
    return JSON.stringify({
        video_path: getWidgetValue(node, "video_path", ""),
        force_size: getWidgetValue(node, "force_size", ""),
        custom_width: getWidgetValue(node, "custom_width", 0),
        custom_height: getWidgetValue(node, "custom_height", 0),
        pause_on_execute: !!getWidgetValue(node, "pause_on_execute", false),
        pause_timeout: getWidgetValue(node, "pause_timeout", 0),
        current_frame: getWidgetValue(node, "current_frame", 0),
        // 2026-07-13: 入点帧/出点帧 已重命名为 开始帧/结束帧,这里同步用新名查找。
        start_frame: getWidgetValue(node, "开始帧", 0),
        end_frame: getWidgetValue(node, "结束帧", 0),
        select_every_nth_frame: getWidgetValue(node, "select_every_nth_frame", 0),
        // 分段计划参数
        segment_plan: getWidgetValue(node, "分段计划", "禁用"),
        segment_length: getWidgetValue(node, "分段长度", 81),
        segment_index: getWidgetValue(node, "分段索引", 0),
        images_connected: isInputConnected(node, "images"),
        audio_connected: isInputConnected(node, "audio"),
        fps_connected: isInputConnected(node, "fps"),
    });
}

function setQueuedOnOtherVideoLoaders(activeNode) {
    if (!activeNode?._zyfNeedsUpdate) {
        return;
    }
    const nodes = activeNode?.graph?._nodes ?? app.graph?._nodes ?? [];
    for (const node of nodes) {
        if (!node || node === activeNode) {
            continue;
        }
        if (!isVideoLoaderNode(node)) {
            continue;
        }
        if (node._zyfPauseActive || node._zyfWaitingForOtherPause) {
            continue;
        }
        if (!node._zyfNeedsUpdate) {
            continue;
        }
        const signature = computeVideoLoaderSignature(node);
        if (node._zyfLastExecutedSignature === signature) {
            node._zyfNeedsUpdate = false;
            continue;
        }
        const pauseWidget = node.widgets?.find((w) => w.name === "pause_on_execute");
        if (!pauseWidget?.value) {
            continue;
        }
        node._zyfQueuedActive = true;
        node.previewWidget?.setProcessing?.(true, "Queued for execution...");
    }
}

function clearQueuedVideoLoaderOverlays() {
    const nodes = app.graph?._nodes ?? [];
    for (const node of nodes) {
        if (!node || !isVideoLoaderNode(node)) {
            continue;
        }
        if (node._zyfPauseActive) {
            continue;
        }
        if (node._zyfQueuedActive || node._zyfWaitingForOtherPause) {
            node._zyfQueuedActive = false;
            node._zyfWaitingForOtherPause = false;
            node.previewWidget?.setProcessing?.(false);
        }
    }
}

function setupVideoLoaderNodeHandlers(nodeType) {
    if (nodeType?.prototype?._zyfExecutionHandlersPatched) {
        return;
    }
    nodeType.prototype._zyfExecutionHandlersPatched = true;

    const originalOnExecutionStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function () {
        this.previewWidget?.videoEl?.pause?.();
        const pauseWidget = this.widgets?.find((w) => w.name === "pause_on_execute");
        const signature = computeVideoLoaderSignature(this);
        const lastSignature = this._zyfLastSignature ?? this._zyfLastExecutedSignature;
        if (lastSignature === signature) {
            this._zyfNeedsUpdate = false;
        } else {
            this._zyfNeedsUpdate = true;
        }
        this._zyfLastSignature = signature;
        setQueuedOnOtherVideoLoaders(this);
        this._zyfQueuedActive = false;
        if (pauseWidget?.value && (this._zyfNeedsUpdate ?? true)) {
            this.previewWidget?.setProcessing?.(true, "Processing media...");
        }

        originalOnExecutionStart?.apply(this, arguments);
    };

    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output) {
        originalOnExecuted?.apply(this, arguments);
        this.previewWidget?.setProcessing?.(false);
        this._zyfNeedsUpdate = false;
        this._zyfQueuedActive = false;
        const valueOrFirst = (value) => {
            if (Array.isArray(value)) {
                return value.length ? value[0] : undefined;
            }
            return value;
        };
        const readOutputValue = (idx, names) => {
            if (!output) {
                return undefined;
            }
            const fromArray = valueOrFirst(output?.[idx] ?? output?.output?.[idx] ?? output?.outputs?.[idx]);
            if (fromArray !== undefined) {
                return fromArray;
            }
            if (output?.output && typeof output.output === "object") {
                for (const name of names) {
                    if (name in output.output) {
                        return valueOrFirst(output.output[name]);
                    }
                }
            }
            if (output?.outputs && typeof output.outputs === "object") {
                for (const name of names) {
                    if (name in output.outputs) {
                        return valueOrFirst(output.outputs[name]);
                    }
                }
            }
            if (typeof output === "object") {
                for (const name of names) {
                    if (name in output) {
                        return valueOrFirst(output[name]);
                    }
                }
            }
            return undefined;
        };

        const frameIn = readOutputValue(2, ["Frame in", "frame_in", "frame in"]);
        const frameOut = readOutputValue(3, ["Frame out", "frame_out", "frame out"]);
        const frameCountAbs = readOutputValue(6, ["Frame count (abs)", "frame_count_abs", "frame count (abs)"]);
        const currentFrameAbs = readOutputValue(8, ["Current frame (abs)", "current_frame_abs", "current frame (abs)"]);
        const frameRateFloat = readOutputValue(10, ["Frame rate (FLOAT)", "frame_rate_float", "frame rate (float)"]);
        const frameRateInt = readOutputValue(9, ["Frame rate (INT)", "frame_rate_int", "frame rate (int)"]);

        const totalFrames = Number.isFinite(Number(frameCountAbs)) ? Number(frameCountAbs) : undefined;
        const currentFrame = Number.isFinite(Number(currentFrameAbs)) ? Number(currentFrameAbs) : undefined;
        const inPoint = Number.isFinite(Number(frameIn)) ? Number(frameIn) : undefined;
        const outPoint = Number.isFinite(Number(frameOut)) ? Number(frameOut) : undefined;
        const frameRate = Number.isFinite(Number(frameRateFloat)) ? Number(frameRateFloat)
            : Number.isFinite(Number(frameRateInt)) ? Number(frameRateInt) : undefined;

        const updates = {};
        if (totalFrames !== undefined) updates.totalFrames = totalFrames;
        if (currentFrame !== undefined) updates.currentFrame = currentFrame;
        if (inPoint !== undefined) updates.inPoint = inPoint;
        if (outPoint !== undefined) updates.outPoint = outPoint;
        if (frameRate !== undefined) updates.frameRate = frameRate;

        if (Object.keys(updates).length && this.previewWidget) {
            this.previewWidget.value = this.previewWidget.value || { params: {} };
            this.previewWidget.value.params = this.previewWidget.value.params || {};
            if (updates.totalFrames !== undefined) {
                this.previewWidget.value.params.totalFrames = updates.totalFrames;
            }
            if (updates.frameRate !== undefined) {
                this.previewWidget.value.params.frameRate = updates.frameRate;
            }
            this.previewWidget.value.params.frameDuration = updates.frameRate ? 1 / updates.frameRate : this.previewWidget.value.params.frameDuration;
            this.previewWidget.value.params.duration = updates.frameRate && updates.totalFrames ? updates.totalFrames / updates.frameRate : this.previewWidget.value.params.duration;
        }
        if (Object.keys(updates).length && this.applyFrameState) {
            this.applyFrameState(updates);
        } else if (Object.keys(updates).length && this.timelineWidget?.update) {
            this.timelineWidget.update({
                totalFrames: updates.totalFrames ?? this._zyfFrameState?.totalFrames ?? 1,
                currentFrame: updates.currentFrame ?? this._zyfFrameState?.currentFrame ?? 1,
                inPoint: updates.inPoint ?? this._zyfFrameState?.inPoint ?? 1,
                outPoint: updates.outPoint ?? this._zyfFrameState?.outPoint ?? 1,
            });
        }
        this._zyfLastExecutedSignature = computeVideoLoaderSignature(this);
        this._zyfLastSignature = this._zyfLastExecutedSignature;
    };

    const originalSetSize = nodeType.prototype.setSize;
    nodeType.prototype.setSize = function (size) {
        originalSetSize?.apply(this, arguments);

        const currentSize = Array.isArray(size) ? size : this.size;
        if (!Array.isArray(currentSize) || currentSize.length < 2) {
            return;
        }
        // Enforce a minimum width so the video preview + crop toolbar
        // always fit on one row. 290px is enough for the toolbar
        // (Freeform select + 44px W + 1px × + 44px H = ~165px) plus
        // the 28px scissors + 28px reset buttons + 6px+6px margins
        // = ~233px inside a 290px-wide node, with breathing room.
        // Previously clamped to 390px which made the node feel bulky;
        // users can still drag wider if they want a bigger preview.
        const clampedWidth = Math.max(currentSize[0], 290);
        this.size = [clampedWidth, currentSize[1]];
    };
}

app.registerExtension({
    name: "zyf-video.Core",

    async init() {
        zyfAddStylesheet(zyfGetUrl("css/zyfNodes.css", import.meta.url));

        setupConfigAndSerialization();
        api.addEventListener("execution_end", clearQueuedVideoLoaderOverlays);
        api.addEventListener("execution_error", clearQueuedVideoLoaderOverlays);
        api.addEventListener("execution_interrupted", clearQueuedVideoLoaderOverlays);
        api.addEventListener("status", (event) => {
            const remaining = event?.detail?.exec_info?.queue_remaining;
            if (typeof remaining === "number" && remaining === 0) {
                clearQueuedVideoLoaderOverlays();
            }
        });

        // ---- 分段计划自动排队: 接收Python后端消息, 递增索引并排队下一段 ----
        api.addEventListener("zyf-segment-auto-queue", (event) => {
            const { uid, next_index, segment_count } = event.detail || {};
            const node = app.graph?.getNodeById?.(String(uid));
            if (!node) return;
            const segIdxWidget = node.widgets?.find(w => w.name === "分段索引");
            if (!segIdxWidget) return;
            segIdxWidget.value = next_index;
            if (segIdxWidget.inputEl) segIdxWidget.inputEl.value = String(next_index);
            node.setDirtyCanvas?.(true, true);
            // 排队下一段
            setTimeout(() => {
                const btn = document.querySelector("#queue-button") || document.querySelector(".comfyui-queue-button");
                if (btn) {
                    btn.click();
                } else if (typeof app.queuePrompt === "function") {
                    app.queuePrompt(0, 1);
                } else {
                    app.graphToPrompt?.().then(p => {
                        fetch("/prompt", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ prompt: p.output }),
                        });
                    }).catch(() => {});
                }
            }, 500);
        });
    },
    async setup() {
        registerGroupExtensions();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name.indexOf("ZyfVideoLoader") !== -1) {
            await createVideoLoaderWidgets(nodeType);
            try { addSyncPlayLoader(nodeType); } catch (e) { console.warn("[zyf-video] addSyncPlayLoader failed:", e); }
            setupVideoLoaderNodeHandlers(nodeType);
        } else if (nodeData?.name === "ZyfVideoSaver") {
            await createVideoSaverWidgets(nodeType);
            try { addSyncPlaySaver(nodeType); } catch (e) { console.warn("[zyf-video] addSyncPlaySaver failed:", e); }
        } else if (nodeData?.name === "ZyfFrameInfoUnpack") {
            await patchZyfInfoUnpackNode(nodeType);
        }

        // Always apply tooltips for any Zyf* node.
        const originalOnNodeCreated = nodeType?.prototype?.onNodeCreated;
        if (nodeType?.prototype && !nodeType.prototype._zyfTooltipPatched) {
            nodeType.prototype._zyfTooltipPatched = true;
            nodeType.prototype.onNodeCreated = function () {
                originalOnNodeCreated?.apply(this, arguments);
                applyZyfTooltips(this);
            };
        }
    },
});

/**
 * zyf视频信息解包: 这是一个轻量级节点,Python 端只声明了 '视频信息'
 * 这一个 widget,理论上 ComfyUI 会自动从 INPUT_TYPES 中读取 tooltip。
 * 这里显式包一层 createVideoLoaderWidgets 同款的 onNodeCreated 钩子,
 * 保证 applyZyfTooltips 一定会执行,补全 ComfyUI 旧版不读取
 * ``widget.options.tooltip`` 时的回退。
 */
async function patchZyfInfoUnpackNode(nodeType) {
    if (nodeType?.prototype?._zyfInfoUnpackPatched) {
        return;
    }
    nodeType.prototype._zyfInfoUnpackPatched = true;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        original?.apply(this, arguments);
        applyZyfTooltips(this);
    };
}
