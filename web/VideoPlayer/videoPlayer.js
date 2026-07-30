'use strict';

// === 版本验证日志 - 2026-07-14 zyf-video ===
console.log('[zyf-video] videoPlayer.js loaded - Version: 2026-07-14');
console.log('[zyf-video] 裁剪功能坐标修复已加载');
// =====================================

import { app } from "../../../scripts/app.js"; // For LiteGraph
import { api } from "../../../scripts/api.js";
import { createZYFSpinner } from "../OldSpinner/spinner.js";

import { clamp, zyfGetUrl, zyfUploadFile } from "../utils.js";
import { getZYFPositionStyle } from "../styles.js";
import { handleZYFMouseEvent } from "../eventHandlers.js";
import { processVideoEntry } from "../utils.js";

// Double slider widget
function createDoubleSliderWidget(hostNode, widgetName) {
    const doubleSliderWidget = {
        type: "double_slider",
        name: widgetName,
        serialize: true,
        options: { min: 0, max: 100, step: 1, precision: 1, read_only: false },
        value: { current: 0 , startMarkerFrame: 0, endMarkerFrame: 100, currentFrame: 1, totalFrames: 1 },
        marker: true,
        width_margin: 10,
        draw(ctx, node, widget_width, y, widget_height) { 
            if (!this.inputEl || !this.inputEl.style) {
                return;
            }
            Object.assign(this.inputEl.style, getZYFPositionStyle(ctx, widget_width, y, node, widget_height));
        },
        onWidgetChanged(widget_name, new_value, old_value, widget) {},
        mouse(event, pos, node) {
            return handleZYFMouseEvent(event, pos, node, this.positionUpdatedCallback);
        },
    };
    doubleSliderWidget.inputEl = document.createElement("div");
    doubleSliderWidget.inputEl.style.pointerEvents = "auto";
    doubleSliderWidget.inputEl.style.touchAction = "none";
    doubleSliderWidget.inputEl.style.cursor = "pointer";
    doubleSliderWidget.inputEl.style.background = "transparent";
    doubleSliderWidget.dragging = false;
    const updateFromPointer = (event) => {
        const rect = doubleSliderWidget.inputEl.getBoundingClientRect();
        if (!rect.width) {
            return;
        }
        const x = clamp(event.clientX - rect.left, 0, rect.width);
        const nvalue = x / rect.width;
        const value = doubleSliderWidget.options.min
            + (doubleSliderWidget.options.max - doubleSliderWidget.options.min) * nvalue;
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode) ?? doubleSliderWidget;
        const existingValue = sliderWidget.value && typeof sliderWidget.value === "object" ? sliderWidget.value : {};
        sliderWidget.value = {
            ...existingValue,
            current: value,
        };
        if (sliderWidget.positionUpdatedCallback) {
            sliderWidget.positionUpdatedCallback(value);
        } else if (doubleSliderWidget.positionUpdatedCallback) {
            doubleSliderWidget.positionUpdatedCallback(value);
        }
    };
    doubleSliderWidget.inputEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        hostNode._zyfScrubActive = true;
        doubleSliderWidget.pointerIsDown = true;
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
        if (sliderWidget) {
            sliderWidget.pointerIsDown = true;
        }
        doubleSliderWidget.dragging = true;
        doubleSliderWidget.inputEl.setPointerCapture(event.pointerId);
        updateFromPointer(event);
    });
    doubleSliderWidget.inputEl.addEventListener("pointermove", (event) => {
        if (!doubleSliderWidget.dragging) {
            return;
        }
        event.preventDefault();
        updateFromPointer(event);
    });
    doubleSliderWidget.inputEl.addEventListener("pointerup", (event) => {
        if (!doubleSliderWidget.dragging) {
            return;
        }
        event.preventDefault();
        doubleSliderWidget.dragging = false;
        hostNode._zyfScrubActive = false;
        doubleSliderWidget.pointerIsDown = false;
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
        if (sliderWidget) {
            sliderWidget.pointerIsDown = false;
        }
        try {
            doubleSliderWidget.inputEl.releasePointerCapture(event.pointerId);
        } catch {
            // no-op: capture might already be released
        }
        updateFromPointer(event);
    });
    doubleSliderWidget.inputEl.addEventListener("pointercancel", (event) => {
        doubleSliderWidget.dragging = false;
        hostNode._zyfScrubActive = false;
        doubleSliderWidget.pointerIsDown = false;
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
        if (sliderWidget) {
            sliderWidget.pointerIsDown = false;
        }
        try {
            doubleSliderWidget.inputEl.releasePointerCapture(event.pointerId);
        } catch {
            // no-op
        }
    });
    doubleSliderWidget.positionUpdatedCallback = (value) => {
        pauseVideoIfPlaying(hostNode.previewWidget, hostNode.playerControlsWidget);
        const frameAtValue = hostNode.previewWidget.videoEl.getFrameForNValue(value);
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode) ?? doubleSliderWidget;
        const totalFrames = Math.max(1, sliderWidget?.value?.totalFrames ?? 1);
        const clampedValue = clamp(frameAtValue, 1, totalFrames);
        applyFrameState(hostNode, { currentFrame: clampedValue }, { source: "currentFrame", updateVideo: true });
    };    
    
    return doubleSliderWidget;
}

// Player controls widget
const PlayerControls = {
    setInPoint: 0,
    gotoInPoint: 1,
    stepBackward: 2,
    playPause: 3,
    stepForward: 4,
    gotoOutPoint: 5,
    setOutPoint: 6,
};

function createPlayerControlsWidget(widgetName, hostNode, controlClickHandler) {
    const element = document.createElement("div");
    // Strip any default user-agent / LiteGraph margins on the widget
    // root so the toolbar sits flush against the timeline above and
    // the regular widget row below.
    element.style.margin = "0";
    element.style.padding = "0";
    const playerControlsWidget = hostNode.addDOMWidget(widgetName, "player_controls_widget", element, {
        serialize: false,
        hideOnZoom: false,
    });
    playerControlsWidget.computeSize = function (width) {
        // 7 controls in a single row, with a height that scales with the
        // node width: minimum 20px, maximum 28px, target around 1/14 of
        // the row width so the buttons stay close to square. The toolbar
        // is intentionally slim — it shouldn't push the regular widget
        // rows below it off-screen. The final + 15 includes 2px of inner
        // padding (top + bottom of the controls container) plus 3px of
        // bottom margin so the next widget row has breathing room.
        // (Reduced by 3px from the previous +15 to make the toolbar more
        // compact.)
        const w = Math.max(width || 0, 0);
        const h = Math.min(28, Math.max(20, Math.round(w / 14) + 2));
        return [width, h + 15];
    }
    // Apply the computed height back to the widget root element so the
    // grid inside the .player-controls-container can fill it. LiteGraph
    // only sets the width on DOMWidget elements; the height has to be
    // wired up explicitly. The bottom margin creates a small gap
    // between the controls and the next widget row.
    const CONTROLS_BOTTOM_MARGIN = 13;
    const syncControlsHeight = () => {
        const w = Math.max(hostNode?.size?.[0] || 0, 0);
        const visibleHeight = Math.min(28, Math.max(20, Math.round(w / 14) + 2)) + 2;
        element.style.height = `${visibleHeight}px`;
        element.style.boxSizing = "border-box";
        element.style.marginBottom = `${CONTROLS_BOTTOM_MARGIN}px`;
        if (playerControlsWidget.parentEl) {
            playerControlsWidget.parentEl.style.height = `${visibleHeight}px`;
        }
    };
    syncControlsHeight();
    // When the node is resized horizontally, refit the node height so
    // the toolbar (which has a width-scaled computeSize) stays in sync.
    // LiteGraph calls onResize on each DOMWidget after the host node
    // resizes — we re-run zyf_fitHeight to propagate the new toolbar
    // height back up. The fit is deferred to the next tick because
    // LiteGraph sometimes fires onResize before the node is fully
    // assembled (and the height math depends on every widget's
    // computeSize being defined).
    const fitHeight = typeof zyf_fitHeight === "function" ? zyf_fitHeight : null;
    const originalOnResize = playerControlsWidget.onResize;
    playerControlsWidget.onResize = function (width, height) {
        originalOnResize?.apply(this, arguments);
        syncControlsHeight();
        if (fitHeight && hostNode && !hostNode._zyfFitInProgress) {
            setTimeout(() => {
                if (!hostNode._zyfFitInProgress) {
                    fitHeight(hostNode);
                }
            }, 0);
        }
    };
    playerControlsWidget.parentEl = document.createElement("div");
    playerControlsWidget.parentEl.className = "player-controls-container";
    element.appendChild(playerControlsWidget.parentEl);

    playerControlsWidget.controlsEl = document.createElement("div");
    playerControlsWidget.controlsEl.className = "player-grid-container";
    playerControlsWidget.parentEl.appendChild(playerControlsWidget.controlsEl);

    // Images downloaded from Icons8 (https://icons8/com).
    // Order must match PlayerControls enum above. "Go to start" and
    // "Go to end" were removed to keep the toolbar compact.
    const images = [
        zyfGetUrl("../images/set_in_point.png", import.meta.url),
        zyfGetUrl("../images/goto_in_point.png", import.meta.url),
        zyfGetUrl("../images/step_backward.png", import.meta.url),
        zyfGetUrl("../images/pause.png", import.meta.url),
        zyfGetUrl("../images/step_forward.png", import.meta.url),
        zyfGetUrl("../images/goto_out_point.png", import.meta.url),
        zyfGetUrl("../images/set_out_point.png", import.meta.url),
    ];
    const tooltips = [
        "设置开始帧(当前位置标记为序列开始)",
        "跳到开始帧",
        "后退一帧",
        "播放 / 暂停",
        "前进一帧",
        "跳到结束帧",
        "设置结束帧(当前位置标记为序列结束)",
    ];
    for (let i = 0; i < 7; i += 1) {
        const cell = document.createElement("div");
        cell.title = tooltips[i];
        cell.setAttribute("aria-label", tooltips[i]);
        cell.innerHTML = `<img class="player-grid-item" src="${images[i]}" />`;
        playerControlsWidget.controlsEl.appendChild(cell);

        cell.addEventListener("mousedown", function () {
            this.style.opacity = 0.7;
            if (controlClickHandler) {
                controlClickHandler(i);
            }
        });
        cell.addEventListener("mouseup", function () {
            this.style.opacity = 1.0;
        });
        cell.addEventListener("mouseleave", function () {
            this.style.opacity = 1.0;
        });
        cell.addEventListener("touchstart", function (e) {
            this.style.opacity = 0.7;
            e.preventDefault();
            if (controlClickHandler) {
                controlClickHandler(i);
            }
        });
        cell.addEventListener("touchend", function (e) {
            this.style.opacity = 1.0;
            e.preventDefault();
        });
    }

    return playerControlsWidget;
}

function createPauseControlsWidget(hostNode) {
    // Removed: pause controls are no longer needed since the
    // "执行时暂停" widget has been deleted for a more compact UI.
    return null;
}

/**
 * Format a frame count as a `M:SS.S` time string for the timeline
 * label. The display rules (per spec):
 *   - Minutes digit count is auto-sized: 0-9 minutes render as a
 *     single digit (`0:33.5`), 10+ minutes auto-expand to two digits
 *     (`10:00.0`, `60:30.0`) — ComfyUI typically only handles short
 *     clips so the single-digit form is the common case.
 *   - The decimal portion keeps ONE digit (tenths of a second). The
 *     rest of the milliseconds are rounded.
 *   - Rounding can push the seconds to 60.0; in that case we carry
 *     the minute up and reset the seconds to 0.0 so we never render
 *     something like `0:60.0`.
 *
 * @param {number} frames    Frame count (1-based; 0 is treated as 0).
 * @param {number} frameRate Effective frame rate in fps (>0 required).
 * @returns {string}         Time formatted as `M:SS.S` / `MM:SS.S`.
 */
function formatFrameTime(frames, frameRate) {
    if (!Number.isFinite(frames) || frames <= 0
        || !Number.isFinite(frameRate) || frameRate <= 0) {
        return "0:00.0";
    }
    const totalSeconds = frames / frameRate;
    let minutes = Math.floor(totalSeconds / 60);
    const secondsPart = totalSeconds - minutes * 60;
    // Round to 1-decimal precision (tenths of a second).
    let rounded = Math.round(secondsPart * 10) / 10;
    // Carry: rounding may push seconds to 60.0 — bump the minute and
    // reset, otherwise the label would show `0:60.0`.
    if (rounded >= 60) {
        minutes += 1;
        rounded = 0;
    }
    const wholeSeconds = Math.floor(rounded);
    const tenths = Math.round((rounded - wholeSeconds) * 10);
    // 2-digit zero-pad for the seconds field so the label column stays
    // visually stable (e.g. `0:01.5` instead of `0:1.5`).
    const secondsStr = String(wholeSeconds).padStart(2, "0");
    return `${minutes}:${secondsStr}.${tenths}`;
}

function createTimelineWidget(hostNode) {
    const element = document.createElement("div");
    element.className = "zyf-timeline";
    element.style.marginTop = "0";
    element.style.marginBottom = "0";
    element.style.padding = "0";

    const trackEl = document.createElement("div");
    trackEl.className = "zyf-timeline-track";

    const preFillEl = document.createElement("div");
    preFillEl.className = "zyf-timeline-pre";
    trackEl.appendChild(preFillEl);

    const fillEl = document.createElement("div");
    fillEl.className = "zyf-timeline-fill";
    trackEl.appendChild(fillEl);

    const postFillEl = document.createElement("div");
    postFillEl.className = "zyf-timeline-post";
    trackEl.appendChild(postFillEl);

    const inMarkerEl = document.createElement("div");
    inMarkerEl.className = "zyf-timeline-marker zyf-timeline-marker-in";
    trackEl.appendChild(inMarkerEl);

    const outMarkerEl = document.createElement("div");
    outMarkerEl.className = "zyf-timeline-marker zyf-timeline-marker-out";
    trackEl.appendChild(outMarkerEl);

    const currentMarkerEl = document.createElement("div");
    currentMarkerEl.className = "zyf-timeline-marker zyf-timeline-marker-current";
    trackEl.appendChild(currentMarkerEl);

    const labelEl = document.createElement("div");
    labelEl.className = "zyf-timeline-label";
    // The label is rendered as three child spans so the middle
    // separator (·) can be styled independently (larger, black) from
    // the surrounding F / T text. The spans are created ONCE here and
    // reused on every `timelineWidget.update(state)` call — only their
    // text content changes — so the cost per frame is a few textContent
    // assignments and no DOM thrash.
    const labelFrameEl = document.createElement("span");
    labelFrameEl.className = "zyf-timeline-label-frame";
    labelEl.appendChild(labelFrameEl);
    const labelSepEl = document.createElement("span");
    labelSepEl.className = "zyf-timeline-label-sep";
    labelSepEl.textContent = "·";
    labelEl.appendChild(labelSepEl);
    const labelTimeEl = document.createElement("span");
    labelTimeEl.className = "zyf-timeline-label-time";
    labelEl.appendChild(labelTimeEl);
    trackEl.appendChild(labelEl);

    element.appendChild(trackEl);

    const timelineWidget = hostNode.addDOMWidget("timeline_widget", "zyf_timeline_widget", element, {
        serialize: false,
        hideOnZoom: false,
    });
    timelineWidget.computeSize = function (width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    };
    timelineWidget.elements = {
        trackEl,
        preFillEl,
        fillEl,
        postFillEl,
        inMarkerEl,
        outMarkerEl,
        currentMarkerEl,
        labelEl,
        labelFrameEl,
        labelSepEl,
        labelTimeEl,
    };
    timelineWidget.update = function (state) {
        // 2026-07-14: 进度条 marker 定位使用原始总帧数(hostNode._zyfOriginalTotalFrames),
        // 而不是 state.totalFrames(强制帧率换算后的值)。否则当强制帧率被设为很低的值
        // (如 1)时,总帧数会被严重压缩(30 帧 10fps 视频 → 3 帧),导致开始帧 marker
        // 显示在错误位置(33% 而非 3.3%)。
        const visualTotalFrames = Math.max(1, hostNode._zyfOriginalTotalFrames || state.totalFrames || 1);
        const totalFrames = Math.max(1, state.totalFrames || 1);
        const currentFrame = clamp(state.currentFrame || 1, 1, totalFrames);
        const inPoint = clamp(state.inPoint || 1, 1, totalFrames);
        const outPoint = clamp(state.outPoint || totalFrames, 1, totalFrames);

        // 将强制帧率空间下的 inPoint/outPoint/currentFrame 映射回原始帧空间,
        // 使进度条始终以原始总帧数为视觉基准。映射公式:
        //   visualFrame = 1 + (forcedFrame - 1) * (visualTotalFrames - 1) / (totalFrames - 1)
        // 当 totalFrames ≤ 1 时强制帧已退化到单帧,无需映射。
        let visualInPoint = inPoint;
        let visualOutPoint = outPoint;
        let visualCurrent = currentFrame;
        if (totalFrames > 1 && visualTotalFrames > 1) {
            const scale = (visualTotalFrames - 1) / (totalFrames - 1);
            visualInPoint = Math.round(1 + (inPoint - 1) * scale);
            visualOutPoint = Math.round(1 + (outPoint - 1) * scale);
            visualCurrent = Math.round(1 + (currentFrame - 1) * scale);
        }

        const inPct = (visualInPoint / visualTotalFrames) * 100;
        const outPct = (visualOutPoint / visualTotalFrames) * 100;
        const currentPct = (visualCurrent / visualTotalFrames) * 100;

        preFillEl.style.width = `${inPct}%`;

        const fillStart = inPct;
        const fillEnd = clamp(currentPct, inPct, outPct);
        fillEl.style.left = `${fillStart}%`;
        fillEl.style.width = `${Math.max(0, fillEnd - fillStart)}%`;

        postFillEl.style.left = `${outPct}%`;
        postFillEl.style.width = `${Math.max(0, 100 - outPct)}%`;

        inMarkerEl.style.left = `${inPct}%`;
        outMarkerEl.style.left = `${outPct}%`;
        currentMarkerEl.style.left = `${currentPct}%`;

        // Label layout (per spec):
        //   F {currentFrame}/{rangeFrames} · T {currentTime}/{rangeTime}
        // where the time is `M:SS.S` (minutes, seconds, 1-decimal
        // milliseconds) — see formatFrameTime() above for the rounding
        // / carry rules. The frame count itself is not formatted with
        // leading zeros, so very long videos (`1234/5678`) still
        // render compactly.
        //
        // 2026-07-13: 显示的"总帧数/总时长"由原来的"源视频 total"改为
        // "播放区间 [开始帧, 结束帧] 的长度"——即结束帧 - 开始帧 + 1。
        // 这样用户调整开始帧/结束帧时,标签里的分母会跟着实时变化,
        // 符合"总帧数和总时长也会相应的改变"的需求。
        //
        // The label is built from three pre-allocated child spans
        // (F section, separator `·`, T section) so the separator can
        // be styled independently (slightly larger, black) — see
        // .zyf-timeline-label-sep in zyfNodes.css.
        const frameRate = Number(state.frameRate);
        const rangeFrames = Math.max(1, outPoint - inPoint + 1);
        // 当前帧在区间内的相对位置(也是实际播放时的"第几帧")
        const currentInRange = clamp(currentFrame - inPoint + 1, 1, rangeFrames);
        const currentTimeStr = formatFrameTime(currentInRange, frameRate);
        const totalTimeStr = formatFrameTime(rangeFrames, frameRate);
        labelFrameEl.textContent = `F ${currentInRange}/${rangeFrames}`;
        // labelSepEl.textContent is set once at creation time; no need
        // to re-write it on every update.
        labelTimeEl.textContent = `T ${currentTimeStr}/${totalTimeStr}`;
    };

    const updateFromPointer = (event) => {
        const rect = trackEl.getBoundingClientRect();
        if (!rect.width) {
            return;
        }
        const x = clamp(event.clientX - rect.left, 0, rect.width);
        const nvalue = (x / rect.width) * 100;
        if (!hostNode.previewWidget?.videoEl) {
            return;
        }
        pauseVideoIfPlaying(hostNode.previewWidget, hostNode.playerControlsWidget);
        const frameAtValue = hostNode.previewWidget.videoEl.getFrameForNValue(nvalue);
        const totalFrames = getTotalFramesFromNode(hostNode);
        const clampedValue = clamp(frameAtValue, 1, totalFrames);
        applyFrameState(hostNode, { currentFrame: clampedValue }, { source: "currentFrame", updateVideo: true });
    };
    // 节流 seek: 拖拽时始终用轻量视觉更新(直接更新 timeline DOM),
    // 不经过 applyFrameState 全流程; video seek 间隔至少 100ms。
    let lastScrubSeekTime = 0;
    const SEEK_THROTTLE_MS = 100;
    const updateFromPointerThrottled = (event) => {
        const rect = trackEl.getBoundingClientRect();
        if (!rect.width) return;
        const x = clamp(event.clientX - rect.left, 0, rect.width);
        const nvalue = (x / rect.width) * 100;
        if (!hostNode.previewWidget?.videoEl) return;
        pauseVideoIfPlaying(hostNode.previewWidget, hostNode.playerControlsWidget);
        const frameAtValue = hostNode.previewWidget.videoEl.getFrameForNValue(nvalue);
        const totalFrames = getTotalFramesFromNode(hostNode);
        const clampedValue = clamp(frameAtValue, 1, totalFrames);
        // 轻量视觉更新: 直接更新 timeline DOM,不做 setWidgetValue/requestNodeRedraw
        hostNode.timelineWidget?.update?.({
            totalFrames,
            currentFrame: clampedValue,
            inPoint: hostNode._zyfFrameState?.inPoint ?? 1,
            outPoint: hostNode._zyfFrameState?.outPoint ?? totalFrames,
            frameRate: hostNode._zyfFrameState?.frameRate ?? 30,
        });
        const now = performance.now();
        if (now - lastScrubSeekTime >= SEEK_THROTTLE_MS) {
            applyFrameState(hostNode, { currentFrame: clampedValue }, { source: "currentFrame", updateVideo: true });
            lastScrubSeekTime = now;
        }
    };

    trackEl.style.cursor = "pointer";
    trackEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        hostNode._zyfScrubActive = true;
        timelineWidget.dragging = true;
        trackEl.setPointerCapture(event.pointerId);
        updateFromPointer(event);
    });
    trackEl.addEventListener("pointermove", (event) => {
        if (!timelineWidget.dragging) {
            return;
        }
        event.preventDefault();
        updateFromPointerThrottled(event);
    });
    trackEl.addEventListener("pointerup", (event) => {
        if (!timelineWidget.dragging) {
            return;
        }
        event.preventDefault();
        timelineWidget.dragging = false;
        hostNode._zyfScrubActive = false;
        try {
            trackEl.releasePointerCapture(event.pointerId);
        } catch {
            // no-op
        }
        updateFromPointer(event);
    });
    trackEl.addEventListener("pointercancel", (event) => {
        timelineWidget.dragging = false;
        hostNode._zyfScrubActive = false;
        try {
            trackEl.releasePointerCapture(event.pointerId);
        } catch {
            // no-op
        }
    });

    return timelineWidget;
}

function buildSequenceFrameUrl(sequence, frameIndex) {
    if (!sequence) {
        return "";
    }
    const pad = sequence.pad ?? 5;
    const filename = `${sequence.prefix}_${String(frameIndex).padStart(pad, "0")}.${sequence.ext ?? "png"}`;
    const params = new URLSearchParams({
        filename,
        subfolder: sequence.subfolder ?? "",
        type: sequence.type ?? "temp",
    });
    return api.apiURL(`/view?${params}`);
}

function buildAudioPreviewUrl(preview) {
    if (!preview) {
        return "";
    }
    const params = new URLSearchParams({
        filename: preview.filename,
        subfolder: preview.subfolder ?? "",
        type: preview.type ?? "temp",
    });
    return api.apiURL(`/view?${params}`);
}

function createImageSequencePlayer(previewWidget, hostNode) {
    const listeners = {};
    const player = {
        paused: true,
        ended: false,
        currentFrame: 1,
        frameRate: 30,
        frameDuration: 1 / 30,
        totalFrames: 1,
        addEventListener(event, handler) {
            if (!listeners[event]) {
                listeners[event] = new Set();
            }
            listeners[event].add(handler);
        },
        removeEventListener(event, handler) {
            listeners[event]?.delete(handler);
        },
        _emit(event) {
            for (const handler of listeners[event] ?? []) {
                handler();
            }
        },
        _setCurrentFrame(frame, options = {}) {
            const totalFrames = getTotalFramesFromNode(hostNode) || this.totalFrames || 1;
            const clampedFrame = clamp(frame, 1, totalFrames);
            this.currentFrame = clampedFrame;
            this.currentTime = (clampedFrame - 1) * this.frameDuration;
            previewWidget.renderSequenceFrame?.(clampedFrame);
            if (!options.skipAudio) {
                previewWidget.syncAudioToFrame?.(clampedFrame, { scrub: hostNode._zyfScrubActive });
            }
            if (!options.silent) {
                applyFrameState(hostNode, { currentFrame: clampedFrame }, { source: "currentFrame" });
            }
        },
        setSequence(sequence) {
            this.totalFrames = Math.max(1, sequence?.count ?? 1);
            this.frameRate = sequence?.frame_rate ?? previewWidget.value?.params?.frameRate ?? 30;
            this.frameDuration = this.frameRate ? 1 / this.frameRate : 0;
            this.currentFrame = 1;
            this.ended = false;
            this.paused = true;
            previewWidget.renderSequenceFrame?.(this.currentFrame);
        },
        play() {
            if (!this.paused) {
                return;
            }
            this.paused = false;
            this.ended = false;
            this._emit("playing");
            previewWidget.playAudioFromFrame?.(this.currentFrame);
            const tick = () => {
                if (this.paused) {
                    return;
                }
                // 2026-07-13: 播放区间改为 [inPoint, outPoint],到 outPoint
                // 之后回卷到 inPoint 形成循环,不再以源视频的 totalFrames 为边界。
                const inFrame = this.getInPointFrame();
                const outFrame = this.getOutPointFrame();
                let nextFrame = this.currentFrame + 1;
                if (nextFrame > outFrame) {
                    nextFrame = inFrame;
                }
                if (nextFrame < inFrame) {
                    // 防御:在循环边界计算出来比 inPoint 还小的情况(例如
                    // 区间被外部缩到 0 长度),直接跳到 inPoint 即可。
                    nextFrame = inFrame;
                }
                this._setCurrentFrame(nextFrame, { silent: true });
                applyFrameState(hostNode, { currentFrame: nextFrame }, { source: "currentFrame", updateVideo: false });
                this._timer = setTimeout(tick, Math.max(1, this.frameDuration * 1000));
            };
            this._timer = setTimeout(tick, Math.max(1, this.frameDuration * 1000));
        },
        pause() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            if (!this.paused) {
                this.paused = true;
                this._emit("pause");
                previewWidget.stopAudio?.();
            }
        },
        getFrameForNValue(nvalue) {
            const frameAtValue = parseInt(nvalue * (this.totalFrames || 1) / 100);
            return Math.max(1, frameAtValue);
        },
        getCurrentFrame() {
            return this.currentFrame;
        },
        getStartFrame() {
            return 1;
        },
        getInPointFrame() {
            const state = hostNode?._zyfFrameState;
            if (state?.inPoint) {
                return state.inPoint;
            }
            const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
            return sliderWidget?.value?.startMarkerFrame ?? 1;
        },
        getOutPointFrame() {
            const state = hostNode?._zyfFrameState;
            if (state?.outPoint) {
                return state.outPoint;
            }
            const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
            return sliderWidget?.value?.endMarkerFrame ?? this.getEndFrame();
        },
        getEndFrame() {
            return this.totalFrames || 1;
        },
        setCurrentFrame(frame, options = {}) {
            this._setCurrentFrame(frame, options);
        },
        advanceOneFrame() {
            const endFrame = this.getEndFrame();
            const nextFrame = Math.min(this.getCurrentFrame() + 1, endFrame);
            this.setCurrentFrame(nextFrame);
        },
        regressOneFrame() {
            const startFrame = this.getStartFrame();
            const previousFrame = Math.max(this.getCurrentFrame() - 1, startFrame);
            this.setCurrentFrame(previousFrame);
        },
        gotoInPoint() {
            const inFrame = this.getInPointFrame();
            this.setCurrentFrame(inFrame);
        },
        gotoOutPoint() {
            const outFrame = this.getOutPointFrame();
            this.setCurrentFrame(outFrame);
        },
        gotoStart() {
            this.setCurrentFrame(this.getStartFrame());
        },
        gotoEnd() {
            this.setCurrentFrame(this.getEndFrame());
        },
        setInPoint(value) {
            const currentFrame = this.getCurrentFrame();
            const valueToSet = value ? value : currentFrame;
            applyFrameState(hostNode, { inPoint: valueToSet }, { source: "inPoint" });
        },
        setOutPoint(value) {
            // 2026-07-13: 结束帧 widget 现在显示的是 count(= state.outPoint -
            // state.inPoint + 1,用户看到的"区间总帧数"),而不是绝对的
            // 源视频结束帧位。这里把 widget 传来的 count 转换成绝对值后再
            // 写入 state.outPoint;工具栏"设置结束帧"按钮则按"当前播放
            // 帧作为结束位"来走,直接传 currentFrame(绝对)。
            let valueToSet;
            if (value !== undefined && value !== null && value !== "") {
                const inPoint = this.getInPointFrame();
                valueToSet = inPoint + Number(value) - 1;
            } else {
                valueToSet = this.getCurrentFrame();
            }
            applyFrameState(hostNode, { outPoint: valueToSet }, { source: "outPoint" });
        },
    };
    return player;
}

// Video preview widget
function createVideoPreviewWidget(hostNode) {
    const infiniteAR = 1000;
    const element = document.createElement("div");
    element.style.minHeight = "140px";
    // Position the audio control's absolute children relative to
    // the widget root, not the nearest `position: fixed` ancestor
    // (the Vue DOMWidget wrapper), so the audio control stays
    // anchored to the bottom-right of the video area.
    element.style.position = "relative";
    element.style.overflow = "visible";
    const previewWidget = hostNode.addDOMWidget("video_preview_widget", "preview", element, {
        serialize: false,
        hideOnZoom: false,
        getValue() {
            return element.value;
        },
        setValue(v) {
            element.value = v;
        },
    });

    previewWidget.computeSize = function (width) {
        const minHeight = 80;
        if (this.aspectRatio && !this.parentEl.hidden) {
            let height = (hostNode.size[0] - 20) / this.aspectRatio + 10;
            if (!(height > 0)) {
                height = minHeight;
            }
            height = Math.max(minHeight, height);
            this.computedHeight = height + 10;
            return [width, height];
        }
        this.computedHeight = minHeight + 10;
        return [width, minHeight];
    }
    previewWidget.aspectRatio = infiniteAR;
    previewWidget.value = { hidden: false, paused: false, params: {} }
    previewWidget._hostNode = hostNode;
    previewWidget.parentEl = document.createElement("div");
    previewWidget.parentEl.setAttribute("data-zyf-preview", "1");
    previewWidget.parentEl.style['position'] = "relative";
    previewWidget.parentEl.style['width'] = "100%";
    previewWidget.parentEl.style['height'] = "100%";
    previewWidget.parentEl.style['minHeight'] = "80px";
    element.appendChild(previewWidget.parentEl);
    previewWidget._videoEl = document.createElement("video");
    previewWidget._videoEl.controls = false;
    // Loop by default after play, until the user explicitly pauses.
    previewWidget._videoEl.loop = true;
    previewWidget._videoEl.muted = true;
    // `height: 100%` + `object-fit: contain` makes the <video> element
    // fill the preview wrapper's content area exactly, with the actual
    // video pixels letterboxed/pillarboxed inside. This is critical for
    // the freeform crop overlay: the crop box, the drag math, and the
    // ResizeObserver all measure against the <video> element's rect,
    // and if the element is shorter than the wrapper (e.g. because it
    // shrunk to its intrinsic aspect ratio while the wrapper grew to
    // the widget's computeSize height) the crop box only covers the
    // top portion of the visible video. Filling the wrapper 100% with
    // `object-fit: contain` makes the wrapper and the video element
    // share the same size, and the crop overlay's `Math.min(cw/vw,
    // ch/vh)` ratio math in `getRenderedVideoRect` already handles
    // both no-letterbox and letterbox/pillarbox layouts correctly.
    previewWidget._videoEl.style['width'] = "100%";
    previewWidget._videoEl.style['height'] = "100%";
    previewWidget._videoEl.style['objectFit'] = "contain";
    previewWidget._videoEl.style['backgroundColor'] = "#000";
    previewWidget._videoEl.style['pointer-events'] = "none";
    previewWidget.videoEl = previewWidget._videoEl;

    previewWidget.imageEl = document.createElement("img");
    previewWidget.imageEl.style.width = "100%";
    previewWidget.imageEl.style.display = "none";
    previewWidget.imageEl.style.pointerEvents = "none";
    previewWidget.parentEl.appendChild(previewWidget.imageEl);
    previewWidget.parentEl.appendChild(previewWidget._videoEl);
    previewWidget.audioEl = document.createElement("audio");
    previewWidget.audioEl.preload = "auto";
    previewWidget.audioEl.crossOrigin = "anonymous";
    previewWidget.audioEl.style.display = "none";
    previewWidget.parentEl.appendChild(previewWidget.audioEl);
    previewWidget._audioSrc = null;
    previewWidget._audioScrubTimer = null;
    previewWidget._audioPending = null;
    previewWidget._audioBoundPlayer = null;
    previewWidget._audioListeners = null;

    // -- Audio mute / volume control -------------------------------------
    // The audio control follows the ComfyUI asset-browser pattern: a
    // small speaker button lives at the bottom-right of the preview
    // with no background. When the user hovers the bar (or focuses
    // it / clicks it), a panel background fades in and the volume
    // slider expands to the left of the button. When the user moves
    // the mouse away or clicks outside, the panel collapses back to
    // just the speaker icon. The mute toggle and volume value are
    // stored on the widget itself, so the user's preference survives
    // loading a new video into the same node (in-memory only; resets
    // on ComfyUI / page reload).
    //
    // Implementation notes:
    //   - The container is absolutely positioned with inline styles
    //     (z-index, pointer-events) so the LiteGraph DOMWidget
    //     wrapper's `transform`-created stacking context does not
    //     bury it under sibling overlays.
    //   - We use `mouseover` / `mouseout` (not `mouseenter` /
    //     `mouseleave`) because `mouseenter` can fail to fire on
    //     elements that are re-parented into a stacking-context
    //     wrapper, and the relatedTarget check gives us reliable
    //     enter / leave semantics.
    //   - The capture-phase click stop-propagation on the container
    //     prevents the click from reaching the underlying videoEl /
    //     LiteGraph canvas (which would otherwise trigger native
    //     play/pause or node-drag handlers).
    const buildAudioControlUi = () => {
        // Pre-existing state from a previous video load on this node
        // — falls back to defaults (unmuted, 80% volume) the first
        // time a video is loaded into this node.
        const existing = previewWidget._audioUserState || {};
        const initialMuted = typeof existing.muted === "boolean" ? existing.muted : false;
        const initialVolume = Number.isFinite(existing.volume) ? existing.volume : 0.8;

        const container = document.createElement("div");
        container.className = "zyf-audio-control";
        // Inline styles so the layout is robust against LiteGraph's
        // CSS reset / Vue wrapper transformations.
        container.style.position = "absolute";
        container.style.right = "6px";
        container.style.bottom = "6px";
        container.style.zIndex = "9999";
        container.style.pointerEvents = "auto";
        container.style.touchAction = "none";
        container.title = "音频控制(点击切换静音 / 拖动调整音量)";
        container.setAttribute("aria-label", "音频控制");
        container.innerHTML = `
            <div class="zyf-audio-panel">
                <input type="range" class="zyf-audio-volume-slider"
                       min="0" max="1" step="0.01" value="${initialVolume}"
                       aria-label="音量" title="音量滑块" tabindex="-1" />
                <button type="button" class="zyf-audio-toggle" aria-label="切换静音" title="切换静音 / 取消静音">
                    <svg class="zyf-audio-icon-speaker" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                    <svg class="zyf-audio-icon-muted" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                    </svg>
                </button>
            </div>
        `;
        const panelEl = container.querySelector(".zyf-audio-panel");
        const button = container.querySelector(".zyf-audio-toggle");
        const slider = container.querySelector(".zyf-audio-volume-slider");
        const setMutedVisual = (muted) => {
            button.classList.toggle("zyf-audio-muted", !!muted);
        };
        setMutedVisual(initialMuted);

        const applyAudioUserState = () => {
            const state = previewWidget._audioUserState;
            if (!state) return;
            // Apply to the live <audio> element if it exists.
            if (previewWidget.audioEl) {
                previewWidget.audioEl.muted = !!state.muted;
                previewWidget.audioEl.volume = Math.max(0, Math.min(1, Number(state.volume) || 0));
            }
        };

        // Initial sync to the <audio> element (it has been created by
        // this point). User gestures later keep the state in sync.
        previewWidget._audioUserState = { muted: initialMuted, volume: initialVolume };
        applyAudioUserState();

        const setMuted = (muted) => {
            previewWidget._audioUserState.muted = !!muted;
            setMutedVisual(previewWidget._audioUserState.muted);
            applyAudioUserState();
        };
        const setVolume = (volume) => {
            const clamped = Math.max(0, Math.min(1, Number(volume) || 0));
            previewWidget._audioUserState.volume = clamped;
            // Touching the volume slider implies the user wants to
            // hear audio. If they had previously muted, unmute on
            // any non-zero volume adjustment.
            if (clamped > 0 && previewWidget._audioUserState.muted) {
                previewWidget._audioUserState.muted = false;
                setMutedVisual(false);
            }
            applyAudioUserState();
        };

        // Toggle the "active" state which shows the panel background
        // and the volume slider. The state is held in a class on the
        // container so CSS can animate it cleanly.
        const setActive = (active) => {
            const desired = !!active;
            const has = container.classList.contains("zyf-audio-active");
            if (desired === has) {
                return;
            }
            container.classList.toggle("zyf-audio-active", desired);
        };

        // Capture-phase click stop-propagation. This prevents the
        // click from bubbling up to the LiteGraph canvas (which
        // would otherwise start a node-drag operation) and from
        // reaching the underlying videoEl (which would otherwise
        // trigger the browser's native play/pause behaviour).
        //
        // IMPORTANT: stopPropagation must only run when the
        // *capture* target is the container itself. If we
        // unconditionally stopPropagation in capture, the event
        // never reaches a click target that lives inside the
        // container (the button / slider) and the button's own
        // click handler silently never fires. Filter by target
        // so that clicks on the button or slider fall through to
        // their own listeners and only "background" panel clicks
        // are swallowed.
        const shouldStop = (event) => event.target === container;
        container.addEventListener("click", (event) => {
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);
        container.addEventListener("mousedown", (event) => {
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);
        container.addEventListener("pointerdown", (event) => {
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);
        container.addEventListener("dblclick", (event) => {
            event.preventDefault();
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);
        container.addEventListener("contextmenu", (event) => {
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);
        container.addEventListener("wheel", (event) => {
            if (shouldStop(event)) {
                event.stopPropagation();
            }
        }, true);

        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setMuted(!previewWidget._audioUserState.muted);
            // Pin the panel open briefly so the user can grab the
            // slider if they want. The mouseleave timer will
            // collapse it ~600ms after they leave the wrapper.
            setActive(true);
            if (pinTimer) {
                clearTimeout(pinTimer);
            }
            pinTimer = setTimeout(() => {
                pinTimer = null;
                // If the mouse is still over the wrapper, the
                // mouseover handler keeps it open. Otherwise the
                // mouseleave handler collapses it.
            }, 600);
        });

        slider.addEventListener("input", (event) => {
            setVolume(parseFloat(event.target.value));
        });
        // Don't let slider drag bubble up into node-drag handlers.
        slider.addEventListener("mousedown", (event) => {
            event.stopPropagation();
            if (pinTimer) {
                clearTimeout(pinTimer);
                pinTimer = null;
            }
            setActive(true);
        });
        slider.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
        });
        slider.addEventListener("click", (event) => {
            event.stopPropagation();
        });

        // Use mouseover / mouseout with a relatedTarget check.
        // mouseenter / mouseleave do not bubble and can silently
        // fail to fire on elements that are re-parented into a
        // stacking-context wrapper, so we use the bubbling pair
        // and filter by relatedTarget.
        let pinTimer = null;
        let leaveTimer = null;
        let insideWrapper = false;
        const setInside = (event) => {
            const next = container.contains(event.relatedTarget);
            if (next === insideWrapper) {
                return;
            }
            insideWrapper = next;
            if (next) {
                if (leaveTimer) {
                    clearTimeout(leaveTimer);
                    leaveTimer = null;
                }
                setActive(true);
            } else {
                if (leaveTimer) {
                    clearTimeout(leaveTimer);
                }
                // Small delay so dragging the slider past the
                // wrapper edge does not cause the panel to flicker
                // closed under the cursor.
                leaveTimer = setTimeout(() => {
                    leaveTimer = null;
                    setActive(false);
                }, 220);
            }
        };
        container.addEventListener("mouseover", setInside);
        container.addEventListener("mouseout", setInside);
        // Focus lifecycle for keyboard accessibility.
        container.addEventListener("focusin", () => setActive(true));
        container.addEventListener("focusout", (event) => {
            if (!container.contains(event.relatedTarget)) {
                setActive(false);
            }
        });
        // Make the button focusable so the user can tab to it.
        button.tabIndex = 0;
        slider.tabIndex = 0;

        return { container, button, slider, panelEl, setMuted, setVolume, applyAudioUserState, setActive };
    };

    const audioControl = buildAudioControlUi();
    previewWidget._audioControl = audioControl;
    // Append to the widget's *root* element (not parentEl) so the
    // audio control is not affected by parentEl's content-driven
    // height. The widget root element has fixed width / height
    // (the DOMWidget wrapper sets it each frame), so absolute
    // positioning against it is stable. This also means the audio
    // control is laid out *outside* the video itself, so it can
    // never be hidden by the video's `display: none` toggling.
    element.appendChild(audioControl.container);
    // Diagnostic — if you ever see this warning, the audio control
    // element did not make it into the DOM and the user is clicking
    // into a void. This should not fire in normal use.
    setTimeout(() => {
        if (!element.contains(audioControl.container)) {
            console.warn("zyf-video audio control was removed from the DOM after being appended");
        }
    }, 0);
    // Re-apply state whenever a new audio source is loaded so a fresh
    // <audio> element picks up the user's stored mute / volume.
    const _origClearAudioSource = previewWidget.clearAudioSource;
    previewWidget.clearAudioSource = function () {
        const result = _origClearAudioSource?.apply(this, arguments);
        audioControl.applyAudioUserState();
        return result;
    };

    previewWidget.clearAudioSource = () => {
        if (!previewWidget.audioEl) {
            return;
        }
        previewWidget.stopAudio?.();
        previewWidget.audioEl.removeAttribute("src");
        previewWidget.audioEl.load();
        previewWidget._audioSrc = null;
    };

    previewWidget.setAudioSource = (preview, options = {}) => {
        if (!previewWidget.audioEl) {
            return;
        }
        if (!preview) {
            previewWidget.clearAudioSource();
            return;
        }
        const url = buildAudioPreviewUrl(preview);
        if (!url || previewWidget._audioSrc === url) {
            return;
        }
        if (!options.keepVideoAudioMode) {
            previewWidget._useVideoAudio = false;
        }
        previewWidget._audioSrc = url;
        previewWidget.audioEl.src = url;
        previewWidget.audioEl.load();
    };

    previewWidget.setAudioSourceFromVideo = () => {
        if (!previewWidget.audioEl) {
            return;
        }
        const filename = previewWidget.value?.params?.filename;
        if (!filename) {
            previewWidget.clearAudioSource();
            return;
        }
        const params = new URLSearchParams({ filename });
        if (previewWidget.value?.params?.type) {
            params.set("type", previewWidget.value.params.type);
        }
        if (previewWidget.value?.params?.format) {
            params.set("format", previewWidget.value.params.format);
        }
        const url = api.apiURL(`/view?${params}`);
        if (previewWidget._audioSrc === url) {
            return;
        }
        previewWidget._useVideoAudio = true;
        previewWidget._audioSrc = url;
        previewWidget.audioEl.src = url;
        previewWidget.audioEl.load();
    };

    previewWidget.requestVideoAudioPreview = async () => {
        if (!previewWidget._useVideoAudio) {
            return;
        }
        const filename = previewWidget.value?.params?.filename;
        if (!filename) {
            return;
        }
        const requestId = (previewWidget._audioPreviewRequestId ?? 0) + 1;
        previewWidget._audioPreviewRequestId = requestId;
        try {
            const params = new URLSearchParams({ filename });
            const totalFrames = Number(previewWidget.value?.params?.totalFrames);
            if (Number.isFinite(totalFrames) && totalFrames > 0) {
                params.set("total_frames", `${Math.floor(totalFrames)}`);
            }
            const res = await api.fetchApi(`/zyf-video-audio-preview?${params.toString()}`);
            const json = await res.json();
            if (previewWidget._audioPreviewRequestId !== requestId) {
                return;
            }
            if (json?.preview) {
                previewWidget.setAudioSource(json.preview, { keepVideoAudioMode: true });
            }
            // audio envelope widget was removed for a more compact UI
        } catch {
            // ignore preview errors
        }
    };

    previewWidget.getAudioTimeForFrame = (frame) => {
        const duration = previewWidget.value?.params?.duration ?? 0;
        const frameDuration = previewWidget.value?.params?.frameDuration ?? 0;
        if (frameDuration > 0) {
            return Math.max(0, (frame - 1) * frameDuration);
        }
        if (duration > 0 && previewWidget.value?.params?.totalFrames) {
            return Math.max(0, (frame - 1) * (duration / previewWidget.value.params.totalFrames));
        }
        return 0;
    };

    previewWidget.playAudioFromFrame = (frame, options = {}) => {
        const audioEl = previewWidget.audioEl;
        if (!audioEl || !previewWidget._audioSrc) {
            return;
        }
        const time = previewWidget.getAudioTimeForFrame(frame);
        const playMode = options.scrub ? "scrub" : "continuous";
        const videoIsPlaying = !previewWidget.videoEl.paused && !previewWidget.videoEl.ended;
        // The user-controlled mute flag is the authoritative source —
        // if the user has muted the audio via the volume control, we
        // respect that even while the video is playing. The user state
        // is mirrored onto the <audio> element below.
        const userState = previewWidget._audioUserState;
        const userMuted = !!(userState && userState.muted);
        const userVolume = (userState && Number.isFinite(userState.volume))
            ? userState.volume
            : audioEl.volume;
        // Volume might be 0 from the slider; treat that as muted for
        // playback purposes (otherwise the element would still play
        // sound at volume 0 but the user clearly wanted silence).
        const effectivelyMuted = userMuted || userVolume <= 0.0;
        const applySeek = () => {
            try {
                audioEl.currentTime = time;
            } catch {
                // ignore seek errors until ready
            }
            // Always sync the audio element's volume / mute to the
            // user-controlled values; this ensures the user state
            // survives a fresh source being loaded into the same
            // node.
            audioEl.volume = Math.max(0, Math.min(1, userVolume));
            audioEl.muted = effectivelyMuted;
            if (playMode === "scrub") {
                // While the user is scrubbing the timeline, fully mute the audio element
                // so that no sound leaks out. Unmuting happens in stopAudio / non-scrub paths.
                if (previewWidget._audioScrubTimer) {
                    clearTimeout(previewWidget._audioScrubTimer);
                }
                audioEl.muted = true;
                if (!audioEl.paused) {
                    audioEl.pause();
                }
                previewWidget._audioScrubTimer = setTimeout(() => {
                    audioEl.muted = true;
                    audioEl.pause();
                }, 50);
                return;
            }
            // Continuous mode (user clicking a frame button, etc.).
            // The audio element is *only* unmuted and played when the video
            // is currently playing — the audio and video are tied together.
            // When the video is paused (e.g. the user just changed the current
            // frame, set the in-point, set the out-point, etc.) we keep the
            // audio element muted and paused, no matter what.
            if (!videoIsPlaying || effectivelyMuted) {
                audioEl.muted = true;
                if (!audioEl.paused) {
                    audioEl.pause();
                }
                return;
            }
            audioEl.muted = false;
            audioEl.play().catch(() => {});
        };
        if (audioEl.readyState >= 1) {
            applySeek();
        } else {
            previewWidget._audioPending = { time, scrub: options.scrub };
            audioEl.addEventListener("loadedmetadata", function onMeta() {
                audioEl.removeEventListener("loadedmetadata", onMeta);
                if (previewWidget._audioPending) {
                    const pending = previewWidget._audioPending;
                    previewWidget._audioPending = null;
                    previewWidget.playAudioFromFrame(frame, pending);
                }
            });
        }
    };

    previewWidget.syncAudioToFrame = (frame, options = {}) => {
        if (options?.skipAudio) {
            return;
        }
        if (isVideoPlaying(previewWidget)) {
            return;
        }
        previewWidget.playAudioFromFrame(frame, { scrub: !!options.scrub });
    };

    previewWidget.stopAudio = () => {
        const audioEl = previewWidget.audioEl;
        if (!audioEl) {
            return;
        }
        if (previewWidget._audioScrubTimer) {
            clearTimeout(previewWidget._audioScrubTimer);
            previewWidget._audioScrubTimer = null;
        }
        // Don't reset `muted` here — the user's mute/volume setting
        // must survive any pause. Just stop playback; the next
        // playAudioFromFrame call (when the user hits play again) will
        // sync the user state onto the element.
        audioEl.pause();
    };

    previewWidget._bindAudioToPlayer = (player) => {
        if (!player || previewWidget._audioBoundPlayer === player) {
            return;
        }
        if (previewWidget._audioBoundPlayer && previewWidget._audioListeners) {
            const previous = previewWidget._audioBoundPlayer;
            const listeners = previewWidget._audioListeners;
            previous.removeEventListener?.("playing", listeners.playing);
            previous.removeEventListener?.("pause", listeners.pause);
            previous.removeEventListener?.("ended", listeners.ended);
        }
        const listeners = {
            playing: () => previewWidget.playAudioFromFrame?.(player.getCurrentFrame?.() ?? 1),
            pause: () => previewWidget.stopAudio?.(),
            ended: () => previewWidget.stopAudio?.(),
        };
        player.addEventListener?.("playing", listeners.playing);
        player.addEventListener?.("pause", listeners.pause);
        player.addEventListener?.("ended", listeners.ended);
        previewWidget._audioBoundPlayer = player;
        previewWidget._audioListeners = listeners;
    };
    previewWidget._zyfSequenceAspectReady = false;
    previewWidget.imageEl.addEventListener("load", () => {
        if (previewWidget.mode !== "image_sequence") {
            return;
        }
        if (previewWidget._zyfSequenceAspectReady) {
            return;
        }
        const width = previewWidget.imageEl.naturalWidth;
        const height = previewWidget.imageEl.naturalHeight;
        if (width > 0 && height > 0) {
            previewWidget.aspectRatio = width / height;
            previewWidget._zyfSequenceAspectReady = true;
            zyf_fitHeight(hostNode);
        }
    });

    previewWidget.sequencePlayer = createImageSequencePlayer(previewWidget, hostNode);
    previewWidget.sequence = null;
    previewWidget.mode = "video";
    previewWidget.renderSequenceFrame = (frame) => {
        if (!previewWidget.sequence) {
            return;
        }
        const frameIndex = clamp(frame, 1, previewWidget.sequence.count || 1);
        previewWidget.imageEl.src = buildSequenceFrameUrl(previewWidget.sequence, frameIndex);
    };
    previewWidget.useImageSequence = (sequence, stateOverrides = {}) => {
        if (!sequence) {
            return;
        }
        previewWidget.sequence = sequence;
        previewWidget.mode = "image_sequence";
        previewWidget._zyfSequenceAspectReady = false;
        previewWidget.imageEl.style.display = "";
        previewWidget._videoEl.style.display = "none";
        previewWidget.videoEl = previewWidget.sequencePlayer;
        previewWidget.sequencePlayer.setSequence(sequence);
        previewWidget._bindAudioToPlayer(previewWidget.sequencePlayer);
        const totalFrames = Math.max(1, sequence.count || 1);
        const frameRate = sequence.frame_rate ?? 30;
        previewWidget.value.params.frameDuration = frameRate ? 1 / frameRate : 0;
        previewWidget.value.params.duration = frameRate ? totalFrames / frameRate : 0;
        previewWidget.value.params.totalFrames = totalFrames;
        previewWidget.value.params.frameRate = frameRate;
        // 2026-07-13: 当前帧 widget 已移除,改用 state 里的
        // _zyfUserCustomized 标志和 state.currentFrame 兜底。
        // 结束帧 widget 现在显示 count,需要把 count 折算回绝对位:
        //   outPoint(绝对) = inPoint + count - 1
        const existingState = ensureFrameState(hostNode);
        const currentFrame = stateOverrides.currentFrame
            ?? (existingState._zyfUserCustomized ? existingState.currentFrame : undefined)
            ?? hostNode.inPointWidget?.value
            ?? 1;
        const inPoint = stateOverrides.inPoint ?? hostNode.inPointWidget?.value ?? 1;
        const outPointCount = stateOverrides.outPoint
            ?? hostNode.outPointWidget?.value
            ?? totalFrames;
        const outPoint = inPoint + Number(outPointCount || totalFrames) - 1;
        applyFrameState(hostNode, {
            totalFrames,
            frameRate,
            currentFrame,
            inPoint,
            outPoint,
        }, { source: "init", updateVideo: true, force: true, skipAudio: true });
        if (previewWidget.loaderEl) {
            previewWidget.loaderEl.style['visibility'] = "hidden";
        }
    };
    previewWidget.useVideoSource = () => {
        if (previewWidget.mode !== "video") {
            previewWidget.mode = "video";
            previewWidget.videoEl = previewWidget._videoEl;
            previewWidget.imageEl.style.display = "none";
            previewWidget._videoEl.style.display = "";
        }
        previewWidget._bindAudioToPlayer(previewWidget._videoEl);
    };

    previewWidget._videoEl.addEventListener("loadedmetadata", async () => {
        previewWidget.aspectRatio = previewWidget.videoEl.videoWidth / previewWidget.videoEl.videoHeight;
        zyf_fitHeight(hostNode);
        previewWidget.loaderEl.style['visibility'] = "visible";

        let params = {}
        Object.assign(params, previewWidget.value.params);
                if (params.filename) {
                    const jsonData = await processVideoEntry(params.filename);
            if (jsonData) {
                previewWidget.loaderEl.style['visibility'] = "hidden";

                // 2026-07-13: 移除了 currentFrameWidget。这里只给两个 widget 一个
                // 临时初值,真正的 min/max 会在 applyFrameState 里按"互相联动"
                // 规则重写(inPoint max = outPoint - 1,outPoint min = 2)。
                [hostNode.inPointWidget, hostNode.outPointWidget].forEach((widget) => {
                    if (!widget?.options) return;
                    widget.options.min = 1;
                    widget.options.max = jsonData.total_frames;
                });

                const componentCreated = hostNode.componentCreated;
                const existingState = ensureFrameState(hostNode);
                const componentLoadedOrRefreshed = existingState._zyfUserCustomized === true;
                previewWidget.value.params.frameDuration = jsonData.frame_duration;
                previewWidget.value.params.duration = jsonData.duration;
                previewWidget.value.params.totalFrames = jsonData.total_frames;
                // 2026-07-14: 修复"裁剪尺寸标签 832×1344 vs 实际输出 831×1344"
                // 的 1 像素不一致。
                //
                // 根因:`/process_video_entry` 用 ffprobe 报的视频 width 是
                // metadata 宽(可能 832),但 ffmpeg 解码后真实 frame width
                // 是 831(yuv420p chroma subsampling 边界对齐损失 1 像素)。
                // 之前 `params.width` 一直用 server.py 报的 metadata 宽,
                // 与后端 `_apply_freeform_crop` 用的 `image_batch.shape[2]`
                // 实际 tensor 宽相差 1 像素,导致前端 cropDimsLabel 用
                // `Math.round(cw * params.width)` 显示 832、下游 IMAGE
                // 实际 shape[2] 是 831。
                //
                // 修复:在 `<video>` 元素的 videoWidth/videoHeight 就绪后
                // 覆盖 `params.width`/`params.height`,这两个值是浏览器
                // 真实解码后的 frame 尺寸,与后端 ffmpeg 解码出的 tensor
                // 必然一致。server.py 报的 ffprobe width 仅作 fallback,
                // 用于 videoWidth 暂时拿不到(metadata 加载但首帧没就绪)的
                // 极短窗口期。
                if (previewWidget.videoEl && Number.isFinite(Number(previewWidget.videoEl.videoWidth)) && Number(previewWidget.videoEl.videoWidth) > 0) {
                    previewWidget.value.params.width = Number(previewWidget.videoEl.videoWidth);
                } else if (Number.isFinite(Number(jsonData.width))) {
                    previewWidget.value.params.width = Number(jsonData.width);
                }
                if (previewWidget.videoEl && Number.isFinite(Number(previewWidget.videoEl.videoHeight)) && Number(previewWidget.videoEl.videoHeight) > 0) {
                    previewWidget.value.params.height = Number(previewWidget.videoEl.videoHeight);
                } else if (Number.isFinite(Number(jsonData.height))) {
                    previewWidget.value.params.height = Number(jsonData.height);
                }
                const totalFrames = jsonData.total_frames;
                const isFreshState = !componentCreated || !componentLoadedOrRefreshed;
                const currentFrame = isFreshState ? 1 : existingState.currentFrame;
                // 2026-07-14: "开始帧 / 结束帧 / 帧间隔"持久化记忆
                // (第四版 —— 修复 widget 兜底逻辑:拖入新视频时 widget 值
                // 是旧视频的残留,不能当成"用户设置的值"来用)。
                //
                // 前几版的核心 bug 复盘:
                //   1. isFreshState 守卫把 inPoint/outCount 封锁在默认值分支
                //      → 第三版修复:拆出守卫,统一走"记忆→widget→默认"流水线
                //   2. widget 兜底把旧视频的默认值(如 140)当成用户设置
                //      → 第四版修复:widget 兜底只在 workflow reload
                //        (componentCreated===true)时启用,拖入新视频时 widget
                //        值不可信(是旧视频的残留),直接跳过 widget 兜底。
                //
                // componentCreated 的生命周期:
                //   - workflow reload:LiteGraph 调用 pathWidget.callback(value, true)
                //     → this.componentCreated = true → widget 值是序列化恢复的
                //       用户设置,可信
                //   - 拖入新视频:pathWidget.callback(newName) 无第二参数
                //     → this.componentCreated 保持 undefined → widget 值是
                //       旧视频的残留,不可信,直接跳过 widget 兜底
                //
                // 持久化规则(不变):
                //   - 记忆写入端:只有用户改到"非默认"才写入,改回默认值清空
                //   - 记忆读取端:三项独立验证(各自清空,互不影响)
                let inPoint;
                let outPointCount;
                {
                    const memInPoint = Number(existingState._zyfUserInPoint);
                    const memOutCount = Number(existingState._zyfUserOutCount);
                    // widget 兜底只在 workflow reload 时启用
                    const useWidgetFallback = componentCreated === true;
                    const widgetInPoint = useWidgetFallback ? Number(hostNode.inPointWidget.value) : NaN;
                    const widgetOutCount = useWidgetFallback ? Number(hostNode.outPointWidget.value) : NaN;

                    // 1) 开始帧 inPoint:独立验证 + 独立清空
                    let candidateInPoint;
                    if (Number.isFinite(memInPoint) && memInPoint >= 1) {
                        candidateInPoint = memInPoint;
                    } else if (Number.isFinite(widgetInPoint) && widgetInPoint >= 1) {
                        candidateInPoint = widgetInPoint;
                    } else {
                        candidateInPoint = 1;
                    }
                    // 验证:inPoint ∈ [1, totalFrames - 1](给结束帧留至少 1 帧)
                    if (candidateInPoint >= 1 && candidateInPoint <= totalFrames - 1) {
                        inPoint = candidateInPoint;
                    } else {
                        inPoint = 1;
                        if (hostNode._zyfFrameState) {
                            hostNode._zyfFrameState._zyfUserInPoint = null;
                        }
                    }

                    // 2) 结束帧 outCount:独立验证 + 独立清空
                    let candidateOutCount;
                    if (Number.isFinite(memOutCount) && memOutCount >= 2) {
                        candidateOutCount = memOutCount;
                    } else if (Number.isFinite(widgetOutCount) && widgetOutCount >= 2) {
                        candidateOutCount = widgetOutCount;
                    } else {
                        candidateOutCount = Math.max(2, totalFrames - inPoint + 1);
                    }
                    const absoluteOutPoint = inPoint + candidateOutCount - 1;
                    if (candidateOutCount >= 2 && absoluteOutPoint <= totalFrames) {
                        outPointCount = candidateOutCount;
                    } else {
                        outPointCount = Math.max(2, totalFrames - inPoint + 1);
                        if (hostNode._zyfFrameState) {
                            hostNode._zyfFrameState._zyfUserOutCount = null;
                        }
                    }
                }
                // 2026-07-13: 结束帧 widget 现在显示 count。读 widget value
                // (count) 后转回绝对值,再传给 applyFrameState。
                const outPoint = inPoint + outPointCount - 1;
                applyFrameState(hostNode, {
                    totalFrames,
                    frameRate: jsonData.frame_rate,
                    currentFrame,
                    inPoint,
                    outPoint,
                }, { source: "init", updateVideo: true, skipAudio: true });
                // Cache the original (unforced) frame rate and total frames so that
                // changes to force_frame_rate can recompute totalFrames immediately.
                previewWidget.value.params.originalFrameRate = jsonData.frame_rate;
                previewWidget.value.params.originalTotalFrames = totalFrames;
                hostNode._zyfOriginalFrameRate = jsonData.frame_rate;
                hostNode._zyfOriginalTotalFrames = totalFrames;
                // The force frame rate widget value persists across video loads:
                // LiteGraph serializes the widget value, and the user can set it
                // (e.g. to 16) and have it carry over to the next video. We no
                // longer overwrite it on each new video load. Instead, after
                // caching the original fps / totalFrames above, run the
                // recompute step so the slider totalFrames, outPoint max, and
                // effective frame rate reflect the (preserved) forced fps
                // immediately. The widget display value itself stays at
                // whatever the user previously set.
                if (typeof hostNode._recomputeForceFrameRate === "function") {
                    hostNode._recomputeForceFrameRate();
                }
                // 2026-07-14: 帧间隔持久化记忆(第二版)。
                //   - 之前是每次新视频加载都强制重置为 1;
                //   - 现在改为"非默认值才记,默认值要清空":用户改到非 1
                //     时写入 _zyfUserFrameInterval,改回 1 时清空。
                //   - 所以这里只读记忆(记忆非空 → 用户之前明确改过 ≠ 1,
                //     沿用;记忆为空 → 用户没改过 / 已改回 1,回退到 1)。
                //   - 帧间隔的"新视频装不下"判断对 inPoint / outPoint 才有
                //     意义,帧间隔是绝对抽帧间隔,跟总帧数独立,所以这里
                //     跟开始/结束帧的验证/清空完全解耦,不会被一起清掉。
                let frameInterval = 1;
                if (
                    existingState._zyfUserFrameInterval !== null
                    && existingState._zyfUserFrameInterval !== undefined
                    && Number.isFinite(Number(existingState._zyfUserFrameInterval))
                    && Number(existingState._zyfUserFrameInterval) >= 1
                ) {
                    frameInterval = Number(existingState._zyfUserFrameInterval);
                }
                setWidgetValue(hostNode, hostNode.selectEveryNthFrameWidget, frameInterval);
                previewWidget.requestVideoAudioPreview?.();

                let lastTime = 0;
                const syncCurrentFrame = () => {
                    const totalFrames = getTotalFramesFromNode(hostNode);
                    if (!totalFrames) {
                        return;
                    }
                    const currentFrame = clamp(previewWidget.videoEl.getCurrentFrame(), 1, totalFrames);
                    applyFrameState(hostNode, { currentFrame }, { source: "currentFrame" });
                };
                const startRafSync = () => {
                    if (previewWidget._zyfRafId) {
                        return;
                    }
                    const tick = () => {
                        if (!isVideoPlaying(previewWidget)) {
                            previewWidget._zyfRafId = null;
                            return;
                        }
                        if (previewWidget.videoEl.currentTime !== lastTime) {
                            lastTime = previewWidget.videoEl.currentTime;
                            syncCurrentFrame();
                        }
                        previewWidget._zyfRafId = requestAnimationFrame(tick);
                    };
                    previewWidget._zyfRafId = requestAnimationFrame(tick);
                };
                const stopRafSync = () => {
                    if (previewWidget._zyfRafId) {
                        cancelAnimationFrame(previewWidget._zyfRafId);
                        previewWidget._zyfRafId = null;
                    }
                };
                previewWidget._videoEl.addEventListener('timeupdate', syncCurrentFrame);
                previewWidget._videoEl.addEventListener('seeked', syncCurrentFrame);
                // 2026-07-13: 区间循环。当 currentTime 自然推进到 outPoint 对应的
                // 时间点时,直接 seek 回 inPoint 对应时间点继续播放,实现
                // [开始帧, 结束帧] 区间的无缝循环。
                const onRangeLoopTick = () => {
                    const videoEl = previewWidget._videoEl;
                    if (!videoEl || videoEl.paused || videoEl.ended) {
                        return;
                    }
                    const params = previewWidget.value?.params;
                    const totalFrames = Number(params?.totalFrames) || 0;
                    if (totalFrames <= 0) {
                        return;
                    }
                    const duration = Number(params?.duration) || videoEl.duration || 0;
                    if (duration <= 0) {
                        return;
                    }
                    const outPoint = previewWidget.videoEl.getOutPointFrame?.();
                    const inPoint = previewWidget.videoEl.getInPointFrame?.();
                    if (!outPoint || !inPoint || outPoint <= inPoint) {
                        return;
                    }
                    const frameDuration = duration / totalFrames;
                    const outTime = (outPoint - 1) * frameDuration;
                    const inTime = (inPoint - 1) * frameDuration;
                    // 自然推进到 outPoint 附近(留 1.5 帧容差,防止边界帧误差)
                    if (videoEl.currentTime >= outTime - frameDuration * 0.5) {
                        try {
                            videoEl.currentTime = inTime;
                        } catch {
                            // 某些浏览器在快速 seek 时会抛错,忽略
                        }
                    }
                };
                previewWidget._videoEl.addEventListener('timeupdate', onRangeLoopTick);
                previewWidget._videoEl.addEventListener('playing', (event) => {
                    startRafSync();

                    const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
                    if (sliderWidget) {
                        sliderWidget.pointerIsDown = false;
                    }
                });
                previewWidget._videoEl.addEventListener('pause', () => {
                    stopRafSync();
                });
                previewWidget._videoEl.addEventListener('ended', (event) => {
                    stopRafSync();
                    // 2026-07-13: 视频自然播到文件末尾时,若 outPoint < totalFrames
                    // 这里已经发生过 timeupdate 触发的循环 seek;若 outPoint >=
                    // totalFrames 则补一次 seek,确保 [开始帧, 结束帧] 区间内
                    // 永远循环。
                    const params = previewWidget.value?.params;
                    const totalFrames = Number(params?.totalFrames) || 0;
                    const duration = Number(params?.duration) || 0;
                    const inPoint = previewWidget.videoEl.getInPointFrame?.() ?? 1;
                    if (totalFrames > 0 && duration > 0) {
                        const inTime = (inPoint - 1) * (duration / totalFrames);
                        try {
                            previewWidget._videoEl.currentTime = inTime;
                        } catch {
                            // ignore
                        }
                        // 重新启动播放,完成循环
                        const playPromise = previewWidget._videoEl.play();
                        if (playPromise && typeof playPromise.catch === "function") {
                            playPromise.catch(() => {
                                // 自动播放可能被浏览器拦截,降级为显示播放图标
                                setPlayIcon(hostNode.playerControlsWidget);
                            });
                        }
                        return;
                    }
                    setPlayIcon(hostNode.playerControlsWidget);
                });
                
                if (!componentCreated || (componentCreated && !componentLoadedOrRefreshed)) {
                    // First load: keep the video paused on the first
                    // frame so the user can inspect the thumbnail
                    // before hitting play. The toolbar starts in the
                    // "play" state to make it obvious the user has to
                    // press play to start playback.
                    previewWidget._videoEl.pause();
                    setPlayIcon(hostNode.playerControlsWidget);
                }
                else {
                    stopRafSync();
                    setPlayIcon(hostNode.playerControlsWidget);
                }
            }
        }
        setTimeout(() => {
            zyf_fitHeight(hostNode);
        }, 10);
    });
    
    previewWidget._videoEl.addEventListener("error", () => {
        previewWidget.aspectRatio = infiniteAR;
        previewWidget.loaderEl.style['visibility'] = "hidden";
        zyf_fitHeight(hostNode);

        setTimeout(() => {
            previewWidget.value.params.frameDuration = 1;
            previewWidget.value.params.totalFrames = 1;

            // 2026-07-13: 移除了 currentFrameWidget,这里不再 setWidgetValue 它。
            // 结束帧 widget 现在显示 count,最小为 2(count 至少 2 才保证
            // outPoint >= inPoint + 1)。
            setWidgetValue(hostNode, hostNode.inPointWidget, 1);
            setWidgetValue(hostNode, hostNode.outPointWidget, 2);

            // 2026-07-14: 视频加载失败时清空三项持久化记忆,避免下次
            // 成功加载时仍按失效的旧记忆(可能对应更长的旧视频)做判断。
            if (hostNode._zyfFrameState) {
                hostNode._zyfFrameState._zyfUserInPoint = null;
                hostNode._zyfFrameState._zyfUserOutCount = null;
                hostNode._zyfFrameState._zyfUserFrameInterval = null;
            }

            const sliderWidgets = getDoubleSliderWidgets(hostNode);
            for (const sliderWidget of sliderWidgets) {
                sliderWidget.value.startMarkerFrame = 1;
                sliderWidget.value.endMarkerFrame = 1;
                sliderWidget.value.frameRate = 1;
            }

            if (this) {
                this.currentTime = 1;
            }

            const sliderWidget = getPrimaryDoubleSliderWidget(hostNode) ?? hostNode.doubleSliderWidget;
            if (sliderWidget) {
                updateSliderValues(sliderWidget, hostNode, 1, 1);
            }
            applyFrameState(hostNode, {
                totalFrames: 1,
                frameRate: 1,
                currentFrame: 1,
                inPoint: 1,
                outPoint: 1,
            }, { source: "error" });
            zyf_fitHeight(hostNode);
        }, 100);
    });

    // -- External video drag-and-drop -----------------------------------
    // The user can drag a video file (mp4 / webm / mov / ...) from the
    // file system straight onto the preview area to load it into the
    // node. The file is uploaded to ComfyUI's input folder via the
    // /upload/image endpoint (which accepts arbitrary file types), the
    // 视频路径 widget value is updated to point at the freshly uploaded
    // file, and `updateSource` is called to render the preview. The
    // video element is configured to *not* autoplay so the user can
    // inspect the first frame before hitting play.
    const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".ogv"];
    const isLikelyVideoFile = (file) => {
        if (!file) return false;
        if (file.type && file.type.startsWith("video/")) return true;
        const lowerName = (file.name || "").toLowerCase();
        return VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    };
    // Suppress the browser's default "open file" behaviour when a video
    // is dropped anywhere inside the node — we handle it ourselves.
    element.addEventListener("dragover", (event) => {
        if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes("Files")) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
        }
        element.classList.add("zyf-drop-target");
    });
    element.addEventListener("dragleave", (event) => {
        // Only clear the highlight when the cursor actually leaves the
        // element, not when it enters a child — relatedTarget helps
        // filter those cases.
        if (event.relatedTarget && element.contains(event.relatedTarget)) {
            return;
        }
        element.classList.remove("zyf-drop-target");
    });
    element.addEventListener("drop", async (event) => {
        if (!event.dataTransfer) {
            return;
        }
        const files = Array.from(event.dataTransfer.files || []);
        if (!files.length) {
            return;
        }
        const file = files.find(isLikelyVideoFile);
        if (!file) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        element.classList.remove("zyf-drop-target");

        // Show a transient "uploading" overlay so the user knows we
        // are doing something. The actual visual state of the video
        // element is left untouched — we'll swap in the freshly
        // uploaded file once the upload completes.
        if (previewWidget.loaderEl) {
            previewWidget.loaderEl.textContent = "Uploading video...";
            previewWidget.loaderEl.style.visibility = "visible";
        }

        try {
            const form = new FormData();
            form.append("image", file, file.name);
            form.append("type", "input");
            form.append("overwrite", "true");
            const uploadResponse = await api.fetchApi("/upload/image", {
                method: "POST",
                body: form,
            });
            if (!uploadResponse.ok) {
                throw new Error(`Upload failed: ${uploadResponse.status}`);
            }
            const uploadResult = await uploadResponse.json();
            const newName = uploadResult?.name || file.name;

            // Wire the freshly uploaded file back into the node: update
            // the 视频路径 widget, mark the node as needing re-execution,
            // and reload the preview. The default load behaviour is to
            // render the first frame as a paused still — no autoplay.
            const videoPathWidget = hostNode.widgets?.find((w) => w.name === "视频路径");
            if (videoPathWidget) {
                // If the dropdown list is configured (it usually is),
                // make sure the new value is present so the widget can
                // display it.
                if (Array.isArray(videoPathWidget.options?.values)
                    && !videoPathWidget.options.values.includes(newName)) {
                    videoPathWidget.options.values.push(newName);
                    videoPathWidget.options.values.sort();
                }
                setWidgetValue(hostNode, videoPathWidget, newName);
                if (typeof videoPathWidget.callback === "function") {
                    videoPathWidget.callback(newName);
                }
            }
            // Make sure the parameter name sent to /view is in sync.
            if (!previewWidget.value) {
                previewWidget.value = { hidden: false, paused: false, params: {} };
            }
            previewWidget.value.params = previewWidget.value.params || {};
            previewWidget.value.params.filename = newName;
            // The video element is configured to *not* autoplay; the
            // user clicks the play control on the toolbar to start
            // playback. This makes the loaded frame behave like a
            // thumbnail by default.
            previewWidget._videoEl.autoplay = false;
            previewWidget._videoEl.pause();
            previewWidget.updateSource?.();
        } catch (error) {
            console.error("zyf-video: video drop upload failed", error);
            if (previewWidget.loaderEl) {
                previewWidget.loaderEl.textContent = `Upload failed: ${error.message || error}`;
                setTimeout(() => {
                    previewWidget.loaderEl.style.visibility = "hidden";
                }, 1500);
            }
        }
    });

    previewWidget.updateSource = function () {
        if (this.mode === "image_sequence") {
            return;
        }
        let params = {}
        Object.assign(params, this.value.params);
        this.parentEl.hidden = this.value.hidden;
        this.videoEl.autoplay = false;
        let target_width = 256
        if (element.style?.width) {
            target_width = element.style.width.slice(0, -2) * 2;
        }
        if (!params.force_size || params.force_size.includes("?") || params.force_size === "禁用" || params.force_size === "Disabled") {
            params.force_size = target_width + "x?"
        } else {
            let size = params.force_size.split("x")
            let ar = parseInt(size[0]) / parseInt(size[1])
            params.force_size = target_width + "x" + (target_width / ar)
        }
        previewWidget.videoEl.src = api.apiURL('/view?' + new URLSearchParams(params));
        this.videoEl.hidden = false;
    }

    previewWidget.updateParameters = (params) => {
        if (!previewWidget.value) {
            previewWidget.value = { hidden: false, paused: false, params: {} };
        }
        if (!previewWidget.value.params || typeof previewWidget.value.params !== "object") {
            previewWidget.value.params = {};
        }
        if (previewWidget.mode === "image_sequence" && params?.filename) {
            previewWidget.useVideoSource();
        }
        Object.assign(previewWidget.value.params, params || {});
        previewWidget.updateSource();
        const shouldUseVideoAudio = !hostNode?._zyfUsingImageInput && !isInputConnected(hostNode, "audio");
        previewWidget._useVideoAudio = shouldUseVideoAudio;
        if (shouldUseVideoAudio) {
            previewWidget.setAudioSourceFromVideo?.();
            previewWidget.requestVideoAudioPreview?.();
        }
        // Re-render the crop overlay so its W/H inputs reflect the
        // new video's output dimensions.
        previewWidget.cropOverlay?.refresh?.();
    };

    previewWidget.videoEl.getFrameForNValue = function (nvalue) {
        const frameAtValue = parseInt(nvalue * previewWidget.value.params.totalFrames / 100);
        return frameAtValue;
    };

    previewWidget.videoEl.getCurrentFrame = function () {
        const params = previewWidget.value.params || {};
        // Use the *current* (possibly forced) frame rate to convert currentTime
        // into a frame index. params.frameRate reflects forced_fps when active,
        // and the original fps otherwise.
        const frameRate = Number(params.frameRate) || 0;
        if (frameRate > 0) {
            return Math.round(this.currentTime * frameRate) + 1;
        }
        return Math.round(this.currentTime / (params.frameDuration || 1)) + 1;
    };
    previewWidget.videoEl.getStartFrame = function () {
        const startFrame = 1;
        return startFrame;
    };
    previewWidget.videoEl.getInPointFrame = function () {
        const state = hostNode?._zyfFrameState;
        if (state?.inPoint) {
            return state.inPoint;
        }
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
        return sliderWidget?.value?.startMarkerFrame ?? 1;
    };
    previewWidget.videoEl.getOutPointFrame = function () {
        const state = hostNode?._zyfFrameState;
        if (state?.outPoint) {
            return state.outPoint;
        }
        const sliderWidget = getPrimaryDoubleSliderWidget(hostNode);
        return sliderWidget?.value?.endMarkerFrame ?? this.getEndFrame();
    };
    previewWidget.videoEl.getEndFrame = function () {
        const endFrame = previewWidget.value.params.totalFrames;
        return endFrame;
    };
    previewWidget.videoEl.setCurrentFrame = function (frame, options = {}) {
        const totalFrames = getTotalFramesFromNode(hostNode) || previewWidget.value.params.totalFrames || 1;
        const clampedFrame = clamp(frame, 1, totalFrames);
        if (previewWidget.value.params.duration && previewWidget.value.params.frameDuration) {
            this.currentTime = clampedFrame / totalFrames * previewWidget.value.params.duration - previewWidget.value.params.frameDuration;
        } else {
            this.currentTime = clampedFrame / totalFrames;
        }
        if (!options.skipAudio) {
            previewWidget.syncAudioToFrame?.(clampedFrame, { scrub: hostNode._zyfScrubActive });
        }
        if (!options.silent) {
            applyFrameState(hostNode, { currentFrame: clampedFrame }, { source: "currentFrame" });
        }
    };
    previewWidget.videoEl.advanceOneFrame = function () {
        const endFrame = this.getOutPointFrame();
        const nextFrame = Math.min(this.getCurrentFrame() + 1, endFrame);
        this.setCurrentFrame(nextFrame);
    };
    previewWidget.videoEl.regressOneFrame = function () {
        const startFrame = this.getInPointFrame();
        const previousFrame = Math.max(this.getCurrentFrame() - 1, startFrame);
        this.setCurrentFrame(previousFrame);
    };
    previewWidget.videoEl.gotoInPoint = function () {
        const inFrame = this.getInPointFrame();
        this.setCurrentFrame(inFrame);
    };
    previewWidget.videoEl.gotoOutPoint = function () {
        const outFrame = this.getOutPointFrame();
        this.setCurrentFrame(outFrame);
    };
    previewWidget.videoEl.gotoStart = function () {
        const startFrame = this.getStartFrame();
        this.setCurrentFrame(startFrame);
    };
    previewWidget.videoEl.gotoEnd = function () {
        const endFrame = this.getEndFrame();
        this.setCurrentFrame(endFrame);
    };
    previewWidget.videoEl.setInPoint = function (value) {
        const currentFrame = this.getCurrentFrame();
        const valueToSet = value ? value : currentFrame;
        applyFrameState(hostNode, { inPoint: valueToSet }, { source: "inPoint" });
    };
    previewWidget.videoEl.setOutPoint = function (value) {
        // 2026-07-13: 结束帧 widget 现在显示 count(= state.outPoint -
        // state.inPoint + 1,用户看到的"区间总帧数"),而不是绝对的
        // 源视频结束帧位。widget 回调传来的是 count,这里要先把 count
        // 折算成 absolute 再写入 state.outPoint(否则用户先改 inPoint 再
        // 改 outPoint 会出现"乱跳"——typed 50 → state.outPoint=50 →
        // widget 自动重算成 count=21,而用户期望 count=50 → state.outPoint
        // = inPoint + 50 - 1)。工具栏"设置结束帧"按钮则按"当前播放
        // 帧作为结束位"来走,直接传 currentFrame(绝对)。
        let valueToSet;
        if (value !== undefined && value !== null && value !== "") {
            const inPoint = this.getInPointFrame();
            valueToSet = inPoint + Number(value) - 1;
        } else {
            valueToSet = this.getCurrentFrame();
        }
        applyFrameState(hostNode, { outPoint: valueToSet }, { source: "outPoint" });
    };
    previewWidget.playPauseTriggeredCallback = () => {
        updatePlayPauseControl(previewWidget, hostNode.playerControlsWidget)
    };

    previewWidget._bindAudioToPlayer(previewWidget._videoEl);
    createLoaderOverlay(previewWidget);
    createCropOverlay(previewWidget);
    return previewWidget;
}

// Video preview widget helpers
function createLoaderOverlay(previewWidget) {
    previewWidget.playPauseOverlayEl = document.createElement("div");
    previewWidget.playPauseOverlayEl.className = "video-loading-overlay-container";
    previewWidget.playPauseOverlayEl.addEventListener('click', function () {
        // Defensive: if the crop editor is currently open, do not toggle
        // play/pause. The crop overlay's setVisible() normally sets this
        // element's pointer-events to "none", but a click may still slip
        // through during the same frame as the toggle, so guard here too.
        if (previewWidget.cropOverlay?.isVisible?.()) return;
        previewWidget.playPauseTriggeredCallback?.call();
        if (!isVideoPlaying(previewWidget)) {
            previewWidget.videoEl.play();
        } else {
            previewWidget.videoEl.pause();
        }
    });
    previewWidget.parentEl.appendChild(previewWidget.playPauseOverlayEl);

    previewWidget.loaderEl = document.createElement("div");
    previewWidget.loaderEl.className = "video-loading-overlay";
    previewWidget.parentEl.appendChild(previewWidget.loaderEl);

    previewWidget.spinnerEl = document.createElement("div");
    previewWidget.spinnerEl.className = "video-loading-spinner";
    previewWidget.spinnerEl.appendChild(createZYFSpinner());
    previewWidget.loaderTextEl = document.createElement("div");
    previewWidget.loaderTextEl.className = "zyf-loader-text";
    previewWidget.loaderTextEl.textContent = "Processing...";
    previewWidget.spinnerEl.appendChild(previewWidget.loaderTextEl);
    previewWidget.loaderEl.appendChild(previewWidget.spinnerEl);
}

// =========================================================================
// Freeform crop overlay
// =========================================================================
// A draggable / resizable box on top of the video preview. The user can
// toggle it with a small button in the top-right of the video area,
// pick an aspect ratio (Freeform / Original / 1:1 / 16:9 / 9:16 / ...)
// and see the cropped pixel dimensions update live. Values are written
// to the four 裁剪X/Y/W/H widgets so they survive workflow reloads.
const CROP_RATIOS = [
    { name: "Freeform",  val: 0 },
    { name: "Original",  val: -1 },
    { name: "1:1",       val: 1 },
    { name: "4:5",       val: 4 / 5 },
    { name: "5:4",       val: 5 / 4 },
    { name: "16:9",      val: 16 / 9 },
    { name: "9:16",      val: 9 / 16 },
    { name: "4:3",       val: 4 / 3 },
    { name: "3:4",       val: 3 / 4 },
    { name: "3:2",       val: 3 / 2 },
    { name: "2:3",       val: 2 / 3 },
    { name: "2:1",       val: 2 },
    { name: "1:2",       val: 1 / 2 },
];
const CROP_MIN_FRACTION = 0.02;

function clampCropFraction(v) {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function createCropOverlay(previewWidget) {
    const hostNode = previewWidget._hostNode;
    if (!hostNode) return;

    // Crop toggle button (top-right of the video).
    // Renders as a line-style "crop" SVG icon (square frame with rounded
    // corners, top-left corner extends outward left+up, bottom-right
    // corner extends outward right+down, diagonal line from bottom-left
    // to top-right). White-stroked, no fill. Transparent by default;
    // hover / focus / crop-open show a dark-gray background.
    const CROP_TOGGLE_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
             aria-hidden="true">
            <path d="M6 2v14a2 2 0 0 0 2 2h14"/>
            <path d="M18 22V8a2 2 0 0 0-2-2H2"/>
            <line x1="15" y1="3" x2="21" y2="3"/>
            <line x1="21" y1="3" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="3" y2="21"/>
            <line x1="3" y1="21" x2="3" y2="15"/>
            <line x1="7" y1="17" x2="17" y2="7"/>
        </svg>`;
    const toggle = document.createElement("button");
    toggle.className = "zyf-crop-toggle";
    toggle.title = "自由裁剪(在视频上拖拽框选区域,自由指定输出尺寸)";
    toggle.innerHTML = "<span class=\"zyf-crop-toggle-icon\">" + CROP_TOGGLE_SVG + "</span>";
    toggle.setAttribute("aria-label", "自由裁剪");
    previewWidget.parentEl.appendChild(toggle);

    // Screenshot button — top-left of the video preview.
    // Line-style scissors/cut SVG icon: horizontal cutting bar at the top
    // (with small downward feet on each end), a large X formed by two
    // crossing diagonal lines in the middle, and two small handle circles
    // at the bottom. White-stroked, no fill. Transparent by default; hover
    // / focus states show a dark-gray background. Captures the current
    // video frame (with crop applied if active) and copies to clipboard.
    const SCREENSHOT_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
             aria-hidden="true">
            <line x1="3" y1="3" x2="21" y2="3"/>
            <line x1="3" y1="3" x2="3" y2="6"/>
            <line x1="21" y1="3" x2="21" y2="6"/>
            <line x1="6" y1="7" x2="18" y2="19"/>
            <line x1="18" y1="7" x2="6" y2="19"/>
            <circle cx="6" cy="19" r="2.2"/>
            <circle cx="18" cy="19" r="2.2"/>
        </svg>`;
    const screenshotBtn = document.createElement("button");
    screenshotBtn.className = "zyf-screenshot-btn";
    screenshotBtn.title = "截屏当前帧到剪贴板";
    screenshotBtn.innerHTML = "<span class=\"zyf-screenshot-btn-icon\">" + SCREENSHOT_SVG + "</span>";
    screenshotBtn.setAttribute("aria-label", "截屏当前帧");
    previewWidget.parentEl.appendChild(screenshotBtn);

    // "Reset to original" button (↺) shown to the LEFT of the crop toggle
    // button, only while the crop editor is open. Clicking it restores
    // cx=0, cy=0, cw=1, ch=1 (the un-cropped original). Line-style refresh
    // SVG to match the new button look.
    const RESET_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
             aria-hidden="true">
            <polyline points="3 4 3 10 9 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 10"/>
        </svg>`;
    const resetBtn = document.createElement("button");
    resetBtn.className = "zyf-crop-reset";
    resetBtn.title = "恢复原始尺寸(清除裁剪框)";
    resetBtn.innerHTML = "<span class=\"zyf-crop-reset-icon\">" + RESET_SVG + "</span>";
    resetBtn.setAttribute("aria-label", "恢复原始尺寸");
    resetBtn.style.display = "none";
    previewWidget.parentEl.appendChild(resetBtn);

    // Compact "current crop size" badge shown to the LEFT of the scissors
    // button ONLY when there is an active crop (and the crop editor is
    // closed). When the crop is "Full" (no crop applied) the badge is
    // hidden — the absence of a badge is the indicator that the video
    // is at its original size, while the presence of a WxH badge
    // indicates a crop is applied. When the editor is open, the badge
    // is hidden because the toolbar shows live W x H inputs.
    const cropDimsLabel = document.createElement("span");
    cropDimsLabel.className = "zyf-crop-dims";
    cropDimsLabel.textContent = "";
    cropDimsLabel.style.display = "none";
    cropDimsLabel.title = "当前裁剪尺寸(像素)";
    previewWidget.parentEl.appendChild(cropDimsLabel);

    // Top toolbar with aspect ratio + W x H inputs
    const toolbar = document.createElement("div");
    toolbar.className = "zyf-crop-toolbar";
    toolbar.style.display = "none";

    const arSelect = document.createElement("select");
    arSelect.className = "zyf-crop-ar";
    arSelect.title = "裁剪框宽高比(选择 Free 自由拖拽,或锁定为常见比例)";
    CROP_RATIOS.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = String(r.val);
        opt.textContent = r.name;
        arSelect.appendChild(opt);
    });
    arSelect.value = "0";

    const wInput = document.createElement("input");
    wInput.type = "text";
    wInput.className = "zyf-crop-dim";
    wInput.value = "";
    wInput.title = "裁剪宽度(像素)";
    wInput.setAttribute("aria-label", "裁剪宽度");

    const xSep = document.createElement("span");
    xSep.className = "zyf-crop-x";
    xSep.textContent = "×";

    const hInput = document.createElement("input");
    hInput.type = "text";
    hInput.className = "zyf-crop-dim";
    hInput.value = "";
    hInput.title = "裁剪高度(像素)";
    hInput.setAttribute("aria-label", "裁剪高度");

    toolbar.appendChild(arSelect);
    toolbar.appendChild(wInput);
    toolbar.appendChild(xSep);
    toolbar.appendChild(hInput);
    previewWidget.parentEl.appendChild(toolbar);

    // Crop box overlay (positioned over the video)
    const box = document.createElement("div");
    box.className = "zyf-crop-overlay";
    box.style.display = "none";
    previewWidget.parentEl.appendChild(box);

    // 3x3 rule-of-thirds grid
    for (let i = 1; i <= 2; i++) {
        const v = document.createElement("div");
        v.className = "zyf-crop-gridline zyf-crop-gridline-v";
        v.style.left = `${(i * 100) / 3}%`;
        box.appendChild(v);
        const h = document.createElement("div");
        h.className = "zyf-crop-gridline zyf-crop-gridline-h";
        h.style.top = `${(i * 100) / 3}%`;
        box.appendChild(h);
    }

    // 8 resize handles.
    // Design (mirrors WhatDreamsCost): 20x20 divs positioned with their
    // inner-corner extending ~5px OUTSIDE the box. The visible part is
    // built from 6px solid #0284c7 borders on the relevant sides. Because
    // the borders sit outside the box's content area, they remain visible
    // even though the box has `overflow: hidden` (which clips the handle's
    // div fill but NOT the visible L-shape border). The user can grab
    // ~6px of solid border on each side, which is plenty. Corner handles
    // also get a 6x6 filled inner-corner block (rendered via inset
    // outline + box-shadow) so the actual grab target is obvious.
    //
    // The color #0284c7 (sky-600) is intentionally a couple of shades
    // darker than the box's #38bdf8 (sky-400) outline so the corners/
    // edges stand out as the obvious "grab here" affordance.
    //
    // Edge handles (tm/bm/lm/rm) get a full filled bar (rendered as a
    // box-shadow on the side facing the box) so they remain visible
    // even at small crop sizes and are easier to grab.
    const HANDLE_BORDER_COLOR = "#0284c7";
    const HANDLE_BORDER_WIDTH = "6px";
    const HANDLE_POSITIONS = [
        { name: "tl", cursor: "nwse-resize", pos: { top: "-6px", left: "-6px" }, borders: ["top", "left"] },
        { name: "tr", cursor: "nesw-resize", pos: { top: "-6px", right: "-6px" }, borders: ["top", "right"] },
        { name: "bl", cursor: "nesw-resize", pos: { bottom: "-6px", left: "-6px" }, borders: ["bottom", "left"] },
        { name: "br", cursor: "nwse-resize", pos: { bottom: "-6px", right: "-6px" }, borders: ["bottom", "right"] },
        { name: "tm", cursor: "ns-resize", pos: { top: "-6px", left: "50%" }, transform: "translateX(-50%)", borders: ["top"] },
        { name: "bm", cursor: "ns-resize", pos: { bottom: "-6px", left: "50%" }, transform: "translateX(-50%)", borders: ["bottom"] },
        { name: "lm", cursor: "ew-resize", pos: { top: "50%", left: "-6px" }, transform: "translateY(-50%)", borders: ["left"] },
        { name: "rm", cursor: "ew-resize", pos: { top: "50%", right: "-6px" }, transform: "translateY(-50%)", borders: ["right"] },
    ];
    const CORNER_HANDLES = new Set(["tl", "tr", "bl", "br"]);
    const EDGE_HANDLES = new Set(["tm", "bm", "lm", "rm"]);
    const handles = {};
    for (const def of HANDLE_POSITIONS) {
        const h = document.createElement("div");
        h.className = "zyf-crop-handle";
        if (EDGE_HANDLES.has(def.name)) h.classList.add("zyf-crop-handle-edge");
        h.dataset.handle = def.name;
        h.style.cursor = def.cursor;
        Object.assign(h.style, def.pos);
        if (def.transform) h.style.transform = def.transform;
        def.borders.forEach((b) => {
            h.style[`border${b.charAt(0).toUpperCase() + b.slice(1)}`] = `${HANDLE_BORDER_WIDTH} solid ${HANDLE_BORDER_COLOR}`;
        });
        // Corner handles get a small filled inner-corner square so the
        // grab target has a clear visible fill in addition to the
        // L-shaped border. This is rendered with inset box-shadow on
        // the corner that touches the box, so the filled area is
        // always on the inside-facing side regardless of which corner.
        if (CORNER_HANDLES.has(def.name)) {
            const fillSize = "8px";
            const fillOffset = "0px";
            let shadow = "none";
            if (def.name === "tl") {
                shadow = `inset ${fillOffset} ${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "tr") {
                shadow = `inset -${fillOffset} ${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "bl") {
                shadow = `inset ${fillOffset} -${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "br") {
                shadow = `inset -${fillOffset} -${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            }
            h.style.boxShadow = shadow;
        } else if (EDGE_HANDLES.has(def.name)) {
            // Edge handles get a full filled bar on the side facing the
            // box (the side OPPOSITE the border). This makes the handle
            // visible as a solid blue pill rather than a thin 6px line,
            // so users can find the edge control points immediately.
            //
            //   tm  -> border on top, fill on bottom
            //   bm  -> border on bottom, fill on top
            //   lm  -> border on left, fill on right
            //   rm  -> border on right, fill on left
            // The box has `overflow: hidden`, so we render the fill
            // OUTSIDE the box by sizing the inset shadow to be large
            // enough to be clipped to the visible bar shape.
            const fillSize = "12px";
            let shadow = "none";
            if (def.name === "tm") {
                shadow = `inset 0 -${fillSize} 0 0 ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "bm") {
                shadow = `inset 0 ${fillSize} 0 0 ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "lm") {
                shadow = `inset -${fillSize} 0 0 0 ${HANDLE_BORDER_COLOR}`;
            } else if (def.name === "rm") {
                shadow = `inset ${fillSize} 0 0 0 ${HANDLE_BORDER_COLOR}`;
            }
            h.style.boxShadow = shadow;
        }
        box.appendChild(h);
        handles[def.name] = h;
    }

    // Internal state
    let isVisible = false;
    let currentAspectRatio = 0;
    let dragHandle = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartCx = 0;
    let dragStartCy = 0;
    let dragStartCw = 1;
    let dragStartCh = 1;

    const setSuppressed = (value) => {
        if (hostNode) hostNode._zyfSuppressWidgetCallbacks = value;
    };

    // -- Audio control masking ----------------------------------------------
    // The audio control lives in the bottom-right of the preview widget
    // (see buildAudioControlUi). When the crop editor is open, the
    // bottom-right corner of the crop box sits directly under / on top
    // of the audio control, so every drag of the br corner (or any
    // action that ends near the bottom-right) risks accidentally
    // clicking the speaker button. We therefore suppress the audio
    // control's hit area while the crop overlay is visible, and
    // restore it on close.
    //
    // Implementation: toggle `pointer-events: none` plus a low-opacity
    // visual fade so the user can see the audio control is intentionally
    // disabled. The `inert` attribute would also work, but it requires
    // a polyfill on older browsers — `pointer-events` is sufficient for
    // the click-blocking use case.
    const setAudioControlSuppressed = (suppressed) => {
        const audio = previewWidget._audioControl?.container
            || (hostNode?.previewWidget?.parentEl?.querySelector?.(".zyf-audio-control"))
            || document.querySelector(".zyf-audio-control");
        if (!audio) return;
        // Set up a one-time transition for smooth fade-in/out. Subsequent
        // toggles reuse the same transition so the fade is consistent.
        if (!audio.style.transition) {
            audio.style.transition = "opacity 0.15s ease";
        }
        if (suppressed) {
            audio.style.pointerEvents = "none";
            audio.style.opacity = "0.25";
            audio.setAttribute("aria-hidden", "true");
        } else {
            audio.style.pointerEvents = "auto";
            audio.style.opacity = "";
            audio.removeAttribute("aria-hidden");
        }
    };

    const readWidgets = () => {
        const cx = clampCropFraction(Number(hostNode.cropXWidget?.value ?? 0));
        const cy = clampCropFraction(Number(hostNode.cropYWidget?.value ?? 0));
        let cw = clampCropFraction(Number(hostNode.cropWWidget?.value ?? 1));
        let ch = clampCropFraction(Number(hostNode.cropHWidget?.value ?? 1));
        if (cw < CROP_MIN_FRACTION) cw = CROP_MIN_FRACTION;
        if (ch < CROP_MIN_FRACTION) ch = CROP_MIN_FRACTION;
        // Ensure crop box stays within bounds
        if (cx + cw > 1) {
            if (cw <= 1 - CROP_MIN_FRACTION) {
                cw = 1 - cx;
            } else {
                cw = 1 - CROP_MIN_FRACTION;
                cx = CROP_MIN_FRACTION;
            }
        }
        if (cy + ch > 1) {
            if (ch <= 1 - CROP_MIN_FRACTION) {
                ch = 1 - cy;
            } else {
                ch = 1 - CROP_MIN_FRACTION;
                cy = CROP_MIN_FRACTION;
            }
        }
        return { cx, cy, cw, ch };
    };

    const writeWidgets = (cx, cy, cw, ch) => {
        if (!hostNode) return;
        // Clamp all values before writing
        cx = clampCropFraction(cx);
        cy = clampCropFraction(cy);
        cw = Math.max(CROP_MIN_FRACTION, Math.min(1, cw));
        ch = Math.max(CROP_MIN_FRACTION, Math.min(1, ch));
        // Ensure bounds
        if (cx + cw > 1) cx = 1 - cw;
        if (cy + ch > 1) cy = 1 - ch;
        if (cx < 0) cx = 0;
        if (cy < 0) cy = 0;
        
        setSuppressed(true);
        try {
            if (hostNode.cropXWidget) hostNode.cropXWidget.value = Math.round(cx * 1000) / 1000;
            if (hostNode.cropYWidget) hostNode.cropYWidget.value = Math.round(cy * 1000) / 1000;
            if (hostNode.cropWWidget) hostNode.cropWWidget.value = Math.round(cw * 1000) / 1000;
            if (hostNode.cropHWidget) hostNode.cropHWidget.value = Math.round(ch * 1000) / 1000;
        } finally {
            setSuppressed(false);
        }
        app.graph?.setDirtyCanvas?.(true, false);
    };

    // Compute the *output* (post-resize) pixel dimensions by reading the
    // force_size settings from the standard widgets. Falls back to the
    // video's intrinsic dimensions when force_size is "禁用".
    const getOutputPixelSize = () => {
        // Prefer the values from previewWidget.value.params if available
        // (these are filled in by the Python output and reflect the actual
        // post-resize dimensions). Fall back to the videoEl's natural size.
        const params = previewWidget.value?.params || {};
        let w = Number(params.width) || 0;
        let h = Number(params.height) || 0;
        if (w <= 0 || h <= 0) {
            try {
                w = previewWidget.videoEl?.videoWidth || 0;
                h = previewWidget.videoEl?.videoHeight || 0;
            } catch (e) { w = 0; h = 0; }
        }
        return { w, h };
    };

    // Render the crop box at the current (cx, cy, cw, ch). W/H inputs
    // are updated with the live pixel size unless they're focused
    // (so typing isn't interrupted).
    //
    // Compute the rendered video area within the <video> element.
    // The video element fills the wrapper (width:100%; height:100%)
    // and uses object-fit:contain, so the actual video pixels are
    // letterboxed/pillarboxed inside. This function returns the
    // wrapper-relative rect of the truly visible video area so that
    // the crop box, drag math, and cursor all speak the same
    // coordinate system.
    //
    // Uses the Math.min ratio approach (matching WhatDreamsCost):
    //   ratio  = min(cw / vw, ch / vh)
    //   renderedW = vw * ratio, renderedH = vh * ratio
    //   xOffset = (cw - renderedW) / 2, yOffset = (ch - renderedH) / 2
    const getRenderedVideoRect = () => {
        const videoEl = previewWidget.videoEl;
        if (!videoEl) return null;

        const vw = videoEl.videoWidth || 0;
        const vh = videoEl.videoHeight || 0;
        if (!vw || !vh) return null;

        // The video element fills the wrapper exactly, so its
        // clientWidth/clientHeight equal the wrapper's content area.
        const cw = videoEl.clientWidth;
        const ch = videoEl.clientHeight;
        if (cw <= 0 || ch <= 0) return null;

        const ratio = Math.min(cw / vw, ch / vh);
        const renderedW = vw * ratio;
        const renderedH = vh * ratio;
        const xOffset = (cw - renderedW) / 2;
        const yOffset = (ch - renderedH) / 2;

        return {
            x: xOffset,
            y: yOffset,
            w: renderedW,
            h: renderedH,
        };
    };

    const render = () => {
        const { cx, cy, cw, ch } = readWidgets();
        const rect = getRenderedVideoRect();
        
        if (rect && rect.w > 0 && rect.h > 0) {
            // Calculate crop box position and size in pixels
            const boxLeft = rect.x + cx * rect.w;
            const boxTop = rect.y + cy * rect.h;
            const boxWidth = cw * rect.w;
            const boxHeight = ch * rect.h;
            
            // Position the box over the actual rendered video area.
            box.style.left = `${Math.round(boxLeft)}px`;
            box.style.top = `${Math.round(boxTop)}px`;
            box.style.width = `${Math.round(boxWidth)}px`;
            box.style.height = `${Math.round(boxHeight)}px`;
            
            // 调试信息：在控制台输出详细信息
            console.log('[zyf-video Crop Debug]', {
                rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
                normalized: { cx, cy, cw, ch },
                pixels: { left: Math.round(boxLeft), top: Math.round(boxTop), width: Math.round(boxWidth), height: Math.round(boxHeight) }
            });
            
            // 同时在页面标题显示简要信息
            document.title = `Crop: ${Math.round(boxWidth)}x${Math.round(boxHeight)} at ${Math.round(boxLeft)},${Math.round(boxTop)} | rect:${Math.round(rect.w)}x${Math.round(rect.h)}`;
        } else {
            console.log('[zyf-video Crop Debug] No valid rect - videoEl:', previewWidget.videoEl, 'parentEl:', previewWidget.parentEl);
            document.title = 'Crop: No valid rect';
            // Metadata not loaded yet — keep the box collapsed so it
            // does not appear as a full-bleed rect at the top-left of
            // the parent (which is the entire node, not just the video).
            // The toolbar / badge will still show; the user will see the
            // box as soon as the video's first frame is available.
            box.style.left = `0px`;
            box.style.top = `0px`;
            box.style.width = `0px`;
            box.style.height = `0px`;
        }
        const { w: outW, h: outH } = getOutputPixelSize();
        if (outW > 0 && outH > 0) {
            const dispW = Math.round(cw * outW);
            const dispH = Math.round(ch * outH);
            if (document.activeElement !== wInput) wInput.value = String(dispW);
            if (document.activeElement !== hInput) hInput.value = String(dispH);
        } else {
            if (document.activeElement !== wInput) wInput.value = "";
            if (document.activeElement !== hInput) hInput.value = "";
        }
        // Update the compact badge so it always reflects the latest
        // crop, even while the overlay is closed. The badge shows WxH
        // only when there is a real crop; "Full" (no crop) keeps the
        // badge hidden so the absence of the badge is the indicator
        // of original size. The badge is also hidden when the crop
        // editor is open (toolbar inputs are shown instead).
        const isFull = (cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);
        if (isFull || isVisible) {
            cropDimsLabel.style.display = "none";
        } else if (outW > 0 && outH > 0) {
            const dispW = Math.max(1, Math.round(cw * outW));
            const dispH = Math.max(1, Math.round(ch * outH));
            cropDimsLabel.textContent = `${dispW}×${dispH}`;
            cropDimsLabel.style.display = "inline-flex";
        }
        // Keep the crop box visibility in sync with the current crop
        // state. When the editor is closed and there is a real crop,
        // the box should still render as a dashed 4-sided outline
        // (preview mode) so the user can see the crop region. When
        // there is no crop, the box stays fully hidden. This handles
        // the case where the widgets are changed via the node's
        // input ports (e.g. another ZYF node feeds cx/cy/cw/ch into
        // FrameInfoUnpack which writes back to these widgets) while
        // the editor is closed — setVisible() is not called in that
        // path, so we need render() to keep the box display in sync.
        if (!isVisible) {
            const showPreviewBox = !isFull;
            box.classList.toggle("zyf-crop-overlay--preview", showPreviewBox);
            box.style.display = showPreviewBox ? "block" : "none";
        }
    };

    const setVisible = (visible) => {
        isVisible = !!visible;
        // Always show the box itself if there is an active crop, even
        // when the editor is closed. The "preview" mode shows only
        // the dashed border (handles / gridlines / toolbar hidden)
        // so the user can see the crop region at a glance without
        // having to reopen the editor. If there is no crop, the box
        // stays fully hidden.
        const { cx, cy, cw, ch } = readWidgets();
        const hasCrop = !(cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);
        const showPreview = !isVisible && hasCrop;
        box.classList.toggle("zyf-crop-overlay--preview", showPreview);
        box.style.display = (isVisible || showPreview) ? "block" : "none";
        toolbar.style.display = isVisible ? "flex" : "none";
        // Show the "reset to original" button only while the crop
        // editor is open. When closed, the button disappears so the
        // scissors button stands alone at the top-right of the
        // preview.
        resetBtn.style.display = isVisible ? "inline-flex" : "none";
        // Hide the screenshot button when the crop editor is open so it
        // does not visually overlap with the crop toolbar (which sits
        // at top:5px; left:5px — the same position).
        screenshotBtn.style.display = isVisible ? "none" : "inline-flex";
        // The WxH badge is hidden while the editor is open (the
        // toolbar shows W x H inputs instead). When the editor is
        // closed, render() decides whether to show the badge based
        // on whether there is a real crop. We just bump the z-index
        // in sync with the rest of the toolbar.
        cropDimsLabel.style.zIndex = isVisible ? "151" : "151";
        toggle.classList.toggle("active", isVisible);
        // The playPause overlay sits at z-index 100 (above the crop box
        // at z-index 50) and would otherwise steal every click meant for
        // dragging/resizing the crop box or its handles. Disable its
        // pointer events while the crop editor is open so all clicks
        // pass through to the crop UI underneath. Restore them on close
        // so the rest of the video area can still toggle play/pause.
        const playPauseOverlay = previewWidget.playPauseOverlayEl;
        if (playPauseOverlay) {
            playPauseOverlay.style.pointerEvents = isVisible ? "none" : "auto";
            playPauseOverlay.style.zIndex = isVisible ? "0" : "100";
        }
        // Suppress the bottom-right audio control while the crop editor
        // is open so adjusting the br / bm / rm handles cannot
        // accidentally click the speaker. Restored on close.
        setAudioControlSuppressed(isVisible);
        if (isVisible) {
            // Pause + hide native controls so the browser's own play UI
            // does not appear on top of the crop handles. The crop
            // overlay already pauses the video a few lines down, but
            // toggling `controls` ensures a stray click does not bring
            // up the native timeline or fullscreen button mid-edit.
            const v = previewWidget.videoEl;
            if (v) {
                try { v.controls = false; } catch (err) { /* ignore */ }
                try { v.pause?.(); } catch (err) { /* ignore */ }
            }
            // Ensure crop box is above everything
            box.style.zIndex = "150";
            toolbar.style.zIndex = "151";
            toggle.style.zIndex = "151";
            resetBtn.style.zIndex = "151";
            // Use safeRender so a freshly-replaced videoEl is detected
            // and the loadedmetadata/ResizeObserver are re-bound before
            // the box is positioned.
            safeRender();
        } else {
            dragHandle = null;
            // Reset z-index
            box.style.zIndex = "50";
            toolbar.style.zIndex = "110";
            toggle.style.zIndex = "110";
            resetBtn.style.zIndex = "110";
            cropDimsLabel.style.zIndex = "110";
            // Restore native controls only if the user hasn't disabled
            // them globally on this node (we leave the previous value
            // alone otherwise). The ZYF preview sets `controls = false`
            // at creation, so by default we keep it disabled.
            // Re-render so the WxH badge re-evaluates its visibility
            // against the new `isVisible = false`. Without this call
            // the badge keeps the "hidden" state set by the last
            // render() (which ran while the editor was still open)
            // and the WxH label never reappears after closing.
            // Also ensures the box position snaps to the latest
            // cx/cy/cw/ch (in case the user adjusted the W/H inputs
            // or aspect ratio just before closing).
            safeRender();
        }
    };

    // -- Aspect ratio handler -----------------------------------------------
    const applyAspectRatio = (newRatio) => {
        const { cx, cy, cw, ch } = readWidgets();
        const videoEl = previewWidget.videoEl;
        const vw = videoEl?.videoWidth || 16;
        const vh = videoEl?.videoHeight || 9;
        let ratio = newRatio;
        if (ratio === -1 && vw && vh) {
            ratio = vw / vh;
        }
        currentAspectRatio = (ratio > 0) ? ratio : 0;
        if (currentAspectRatio > 0) {
            // Pick a fitting box anchored at the current center.
            const centerX = cx + cw / 2;
            const centerY = cy + ch / 2;
            // The box dimensions in normalized coordinates such that
            // w/h equals the requested ratio. We scale to fit inside
            // the available space and keep the aspect ratio by scaling
            // the larger dimension.
            let newCw = cw;
            let newCh = ch;
            const currentRatio = (ch > 0) ? (cw / ch) : 1;
            // The R constant matches WhatDreamsCost's `R = ar * (vh/vw)`,
            // which is the ratio in normalized-coordinate space.
            const R = currentAspectRatio * (vh / vw);
            if (R > 0) {
                // Decide which dimension drives the other
                if (R * ch >= cw) {
                    newCh = Math.min(1, ch > 0 ? ch : 1);
                    newCw = newCh * R;
                } else {
                    newCw = Math.min(1, cw > 0 ? cw : 1);
                    newCh = newCw / R;
                }
                if (newCw > 1) newCw = 1;
                if (newCh > 1) newCh = 1;
            }
            let newCx = centerX - newCw / 2;
            let newCy = centerY - newCh / 2;
            if (newCx < 0) newCx = 0;
            if (newCy < 0) newCy = 0;
            if (newCx + newCw > 1) newCx = 1 - newCw;
            if (newCy + newCh > 1) newCy = 1 - newCh;
            writeWidgets(newCx, newCy, newCw, newCh);
        }
        safeRender();
    };

    arSelect.addEventListener("change", () => {
        const r = Number(arSelect.value);
        applyAspectRatio(r);
    });

    // -- W / H manual input handlers ----------------------------------------
    const applyManualDimension = (isWidth) => {
        const { cx, cy, cw, ch } = readWidgets();
        const { w: outW, h: outH } = getOutputPixelSize();
        if (outW <= 0 || outH <= 0) return;
        const newW = Math.max(1, Math.min(parseInt(wInput.value, 10) || Math.round(cw * outW), outW));
        const newH = Math.max(1, Math.min(parseInt(hInput.value, 10) || Math.round(ch * outH), outH));
        let targetW, targetH;
        if (currentAspectRatio > 0) {
            if (isWidth) {
                targetW = newW;
                targetH = Math.round(targetW / currentAspectRatio);
            } else {
                targetH = newH;
                targetW = Math.round(targetH * currentAspectRatio);
            }
            if (targetH > outH) {
                targetH = outH;
                targetW = Math.round(targetH * currentAspectRatio);
            }
            if (targetW > outW) {
                targetW = outW;
                targetH = Math.round(targetW / currentAspectRatio);
            }
        } else {
            targetW = newW;
            targetH = newH;
        }
        targetW = Math.max(1, Math.min(targetW, outW));
        targetH = Math.max(1, Math.min(targetH, outH));
        let nw = targetW / outW;
        let nh = targetH / outH;
        let nx = cx;
        let ny = cy;
        if (nx + nw > 1) nx = 1 - nw;
        if (ny + nh > 1) ny = 1 - nh;
        if (nx < 0) nx = 0;
        if (ny < 0) ny = 0;
        writeWidgets(nx, ny, nw, nh);
        safeRender();
    };
    wInput.addEventListener("change", () => applyManualDimension(true));
    hInput.addEventListener("change", () => applyManualDimension(false));
    wInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyManualDimension(true); });
    hInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyManualDimension(false); });

    // -- Pointer drag handlers ----------------------------------------------
    // Note: AR-lock math reads `previewWidget.videoEl` directly (NOT a
    // captured reference) so it always sees the current element. The
    // previous version captured `dragVideoEl` at the top of this scope
    // to avoid a TDZ trap with an earlier `videoEl` declaration; now
    // that all references go through `previewWidget.videoEl`, that
    // hoisting is no longer needed.
    const onPointerMove = (e) => {
        if (!dragHandle) return;
        e.preventDefault();
        e.stopPropagation();
        
        // Normalize the drag delta against the *rendered* video area,
        // not the <video> container, so the box tracks the cursor 1:1
        // even when the container is letterboxed/pillarboxed.
        const rect = getRenderedVideoRect();
        if (!rect || !rect.w || !rect.h) return;
        const dx = (e.clientX - dragStartX) / rect.w;
        const dy = (e.clientY - dragStartY) / rect.h;

        let newCx = dragStartCx;
        let newCy = dragStartCy;
        let newCw = dragStartCw;
        let newCh = dragStartCh;

        if (dragHandle === "center") {
            newCx = dragStartCx + dx;
            newCy = dragStartCy + dy;
        } else {
            if (dragHandle === "tl") {
                newCx = dragStartCx + dx;
                newCy = dragStartCy + dy;
                newCw = dragStartCw - dx;
                newCh = dragStartCh - dy;
            } else if (dragHandle === "tr") {
                newCy = dragStartCy + dy;
                newCw = dragStartCw + dx;
                newCh = dragStartCh - dy;
            } else if (dragHandle === "bl") {
                newCx = dragStartCx + dx;
                newCw = dragStartCw - dx;
                newCh = dragStartCh + dy;
            } else if (dragHandle === "br") {
                newCw = dragStartCw + dx;
                newCh = dragStartCh + dy;
            } else if (dragHandle === "tm") {
                newCy = dragStartCy + dy;
                newCh = dragStartCh - dy;
            } else if (dragHandle === "bm") {
                newCh = dragStartCh + dy;
            } else if (dragHandle === "lm") {
                newCx = dragStartCx + dx;
                newCw = dragStartCw - dx;
            } else if (dragHandle === "rm") {
                newCw = dragStartCw + dx;
            }

            // Aspect ratio lock
            if (currentAspectRatio > 0) {
                const currentVideo = previewWidget.videoEl;
                const vw = (currentVideo && currentVideo.videoWidth) || rect.w || 1;
                const vh = (currentVideo && currentVideo.videoHeight) || rect.h || 1;
                const R = currentAspectRatio * (vh / vw);
                
                if (dragHandle === "tm" || dragHandle === "bm") {
                    // Height-driven resize
                    newCw = newCh * R;
                    // Center horizontally
                    newCx = dragStartCx + (dragStartCw - newCw) / 2;
                } else if (dragHandle === "lm" || dragHandle === "rm") {
                    // Width-driven resize
                    newCh = newCw / R;
                    // Center vertically
                    newCy = dragStartCy + (dragStartCh - newCh) / 2;
                } else {
                    // Corner resize - maintain aspect ratio
                    newCh = newCw / R;
                }
            }
        }

        // Enforce minimum size first
        if (newCw < CROP_MIN_FRACTION) newCw = CROP_MIN_FRACTION;
        if (newCh < CROP_MIN_FRACTION) newCh = CROP_MIN_FRACTION;
        
        // Clamp position to stay within bounds
        if (newCx < 0) newCx = 0;
        if (newCy < 0) newCy = 0;
        if (newCx + newCw > 1) {
            if (dragHandle === "center") {
                newCx = 1 - newCw;
            } else {
                newCw = 1 - newCx;
            }
        }
        if (newCy + newCh > 1) {
            if (dragHandle === "center") {
                newCy = 1 - newCh;
            } else {
                newCh = 1 - newCy;
            }
        }
        
        // Final safety clamp
        newCx = Math.max(0, Math.min(newCx, 1 - newCw));
        newCy = Math.max(0, Math.min(newCy, 1 - newCh));
        newCw = Math.max(CROP_MIN_FRACTION, Math.min(newCw, 1 - newCx));
        newCh = Math.max(CROP_MIN_FRACTION, Math.min(newCh, 1 - newCy));

        writeWidgets(newCx, newCy, newCw, newCh);
        safeRender();
    };

    const onPointerUp = (e) => {
        if (!dragHandle) return;
        dragHandle = null;
        try { e.target?.releasePointerCapture?.(e.pointerId); } catch (err) { /* ignore */ }
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
    };

    const startDrag = (e, handle) => {
        if (!isVisible) return;
        e.preventDefault();
        e.stopPropagation();
        
        const rect = getRenderedVideoRect();
        if (!rect || !rect.w || !rect.h) return;
        
        dragHandle = handle;
        const { cx, cy, cw, ch } = readWidgets();
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartCx = cx;
        dragStartCy = cy;
        dragStartCw = cw;
        dragStartCh = ch;
        
        try { e.target?.setPointerCapture?.(e.pointerId); } catch (err) { /* ignore */ }
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp, { passive: false });
    };

    box.addEventListener("pointerdown", (e) => {
        if (!isVisible) return;
        // Allow dragging the center if clicking on the box itself or its children (but not handles)
        const isHandle = e.target.classList?.contains('zyf-crop-handle');
        const isGridline = e.target.classList?.contains('zyf-crop-gridline');
        if (!isHandle && (e.target === box || isGridline)) {
            startDrag(e, "center");
        }
    });
    Object.values(handles).forEach((h) => {
        h.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            startDrag(e, h.dataset.handle);
        });
    });

    // Keep the crop box aligned with the video's rendered area when
    // the node is resized or the video's metadata changes.
    //
    // videoEl can be REPLACED at runtime (e.g. switching between a
    // <video> element and a <canvas> sequence player). The previous
    // version of this code captured `videoEl` once and never updated
    // the listeners, so the crop overlay would silently stop tracking
    // the actual current video. We now keep a single ResizeObserver
    // and re-attach the loadedmetadata listener every time the
    // previewWidget.videoEl reference changes — detected lazily on
    // each render() call.
    let ro = null;
    let observedVideoEl = null;
    const ensureResizeObserver = () => {
        if (typeof ResizeObserver === "undefined") return;
        const v = previewWidget.videoEl;
        if (ro) {
            if (v === observedVideoEl) return; // already up to date
            ro.disconnect();
            ro = null;
            observedVideoEl = null;
        }
        ro = new ResizeObserver(() => {
            if (isVisible) safeRender();
        });
        if (previewWidget.parentEl) ro.observe(previewWidget.parentEl);
        if (v) ro.observe(v);
        observedVideoEl = v;
    };
    const onLoadedMetadata = () => {
        // Re-attach the ResizeObserver so it tracks the new metadata
        // size, then re-render to reposition the box.
        ensureResizeObserver();
        if (isVisible) safeRender();
    };
    const onCurrentTimeUpdate = () => {
        // Some browsers reset videoWidth/videoHeight during seeking;
        // re-render to keep the box glued to the video.
        if (isVisible) safeRender();
    };
    const attachVideoListeners = () => {
        const v = previewWidget.videoEl;
        if (!v || v._zyfCropListenersAttached) return;
        v.addEventListener("loadedmetadata", onLoadedMetadata);
        v.addEventListener("seeked", onCurrentTimeUpdate);
        v._zyfCropListenersAttached = true;
    };
    attachVideoListeners();
    ensureResizeObserver();

    // Safety net: re-attach listeners on the next render() if videoEl
    // changed (e.g. sequence player swap). This is a single reference
    // comparison per render — effectively free.
    const origRender = render;
    const renderWithReattach = () => {
        attachVideoListeners();
        ensureResizeObserver();
        origRender();
    };
    // Replace the public-facing render callers (syncFromWidgets /
    // refresh) and the internal references so the re-attach runs every
    // time the box needs to be repositioned. We don't reassign `render`
    // because the existing closures still reference it; instead we wrap
    // the public methods and rely on `renderWithReattach` for the
    // public API. For internal callers (e.g. onPointerMove calling
    // render() directly) we accept the rare case where videoEl changes
    // mid-drag — the next mouse-move will re-run the re-attach path.
    const safeRender = () => renderWithReattach();

    // Toggle button
    toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setVisible(!isVisible);
    });
    // Prevent the toggle from being clickable through to the video
    // underneath (which has its own play/pause handler).
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        toggle.addEventListener(ev, (e) => e.stopPropagation());
    });
    // Also block the toolbar from intercepting node-drag events.
    [toggle, toolbar].forEach((el) => {
        ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
            el.addEventListener(ev, (e) => e.stopPropagation());
        });
    });

    // Helper: compute target (width, height) from force_size settings,
    // mirroring the Python zyf_target_size() logic.
    const computeTargetSize = (srcW, srcH, forceSize, customShortEdge, customLongEdge, sizeMultiple) => {
        let targetW, targetH;
        if (forceSize === "自定义宽高") {
            if (customShortEdge > 0 && customLongEdge > 0) {
                targetW = customShortEdge;
                targetH = customLongEdge;
            } else if (customShortEdge > 0) {
                targetW = customShortEdge;
                targetH = Math.max(1, Math.floor((srcH * customShortEdge) / srcW));
            } else if (customLongEdge > 0) {
                targetH = customLongEdge;
                targetW = Math.max(1, Math.floor((srcW * customLongEdge) / srcH));
            } else {
                return { w: srcW, h: srcH };
            }
        } else if (forceSize === "自定义短边") {
            if (srcW < srcH) {
                targetW = customShortEdge;
                targetH = Math.max(1, Math.floor((srcH * customShortEdge) / srcW));
            } else {
                targetH = customShortEdge;
                targetW = Math.max(1, Math.floor((srcW * customShortEdge) / srcH));
            }
        } else if (forceSize === "自定义长边") {
            if (srcW < srcH) {
                targetH = customLongEdge;
                targetW = Math.max(1, Math.floor((srcW * customLongEdge) / srcH));
            } else {
                targetW = customLongEdge;
                targetH = Math.max(1, Math.floor((srcH * customLongEdge) / srcW));
            }
        } else if (forceSize !== "禁用" && forceSize !== "Disabled") {
            const parts = forceSize.split("x");
            if (parts[0] === "?") {
                targetW = Math.floor((srcW * parseInt(parts[1])) / srcH);
                targetW = (targetW + 4) & ~7;
                targetH = parseInt(parts[1]);
            } else if (parts[1] === "?") {
                targetH = Math.floor((srcH * parseInt(parts[0])) / srcW);
                targetH = (targetH + 4) & ~7;
                targetW = parseInt(parts[0]);
            } else {
                targetW = parseInt(parts[0]);
                targetH = parseInt(parts[1]);
            }
        } else {
            return { w: srcW, h: srcH };
        }
        if (sizeMultiple > 0) {
            targetW = Math.max(sizeMultiple, Math.floor(targetW / sizeMultiple) * sizeMultiple);
            targetH = Math.max(sizeMultiple, Math.floor(targetH / sizeMultiple) * sizeMultiple);
        }
        return { w: targetW, h: targetH };
    };

    // Helper: aspect-preserving center-crop from (srcW,srcH) to match
    // (targetW,targetH) aspect ratio. Returns pixel crop box in source
    // coordinates. Only used when "自定义宽高" specifies both W and H.
    const computeAspectCropPixels = (srcW, srcH, targetW, targetH) => {
        const targetRatio = targetW / targetH;
        const sourceRatio = srcW / srcH;
        if (Math.abs(targetRatio - sourceRatio) < 1e-6) {
            return { sx: 0, sy: 0, sw: srcW, sh: srcH };
        }
        if (targetRatio < sourceRatio) {
            // Source is wider — crop width
            const newW = srcH * targetRatio;
            const cx = (srcW - newW) / 2;
            return { sx: Math.round(cx), sy: 0, sw: Math.round(newW), sh: srcH };
        }
        // Source is taller — crop height
        const newH = srcW / targetRatio;
        const cy = (srcH - newH) / 2;
        return { sx: 0, sy: Math.round(cy), sw: srcW, sh: Math.round(newH) };
    };

    // Read force_size related widgets (may be null if node is not fully initialized)
    const getForceSizeConfig = () => {
        const w = hostNode.widgets || [];
        const sizeWidget = w.find((x) => x.name === "强制尺寸");
        const forceSize = (sizeWidget && sizeWidget.value) ? String(sizeWidget.value).trim() : "禁用";
        const customShort = Number(w.find((x) => x.name === "自定义短边")?.value) || 0;
        const customLong = Number(w.find((x) => x.name === "自定义长边")?.value) || 0;
        const customWidth = Number(w.find((x) => x.name === "自定义宽度")?.value) || 0;
        const customHeight = Number(w.find((x) => x.name === "自定义高度")?.value) || 0;
        const multipleVal = (w.find((x) => x.name === "图像尺寸倍数")?.value) || "无";
        let sizeMultiple = 0;
        if (multipleVal !== "无") {
            sizeMultiple = parseInt(multipleVal) || 0;
        }
        return { forceSize, customShort, customLong, customWidth, customHeight, sizeMultiple };
    };

    // Screenshot button: capture current frame → apply crop → apply force_size
    // → copy to clipboard. The output dimensions respect the user's custom size
    // and size-multiple settings, matching the node's actual output.
    screenshotBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Determine the source element: video for normal video,
        // image for image sequences.
        const isImageSeq = previewWidget.mode === "image_sequence";
        const srcEl = isImageSeq ? previewWidget.imageEl : previewWidget._videoEl;
        if (!srcEl) return;

        const vw = isImageSeq ? (srcEl.naturalWidth || 0) : (srcEl.videoWidth || 0);
        const vh = isImageSeq ? (srcEl.naturalHeight || 0) : (srcEl.videoHeight || 0);
        if (!vw || !vh) return;

        // For video, ensure a frame is ready
        if (!isImageSeq && srcEl.readyState < 2) return;

        // Read crop values (0-1 normalized)
        const { cx, cy, cw, ch } = readWidgets();
        const hasCrop = !(cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);

        let sx, sy, sw, sh;
        if (hasCrop) {
            // Crop region in source pixel coordinates
            sx = Math.round(cx * vw);
            sy = Math.round(cy * vh);
            sw = Math.round(cw * vw);
            sh = Math.round(ch * vh);
        } else {
            sx = 0; sy = 0; sw = vw; sh = vh;
        }

        // Clamp to valid pixel range
        if (sx < 0) { sw += sx; sx = 0; }
        if (sy < 0) { sh += sy; sy = 0; }
        if (sx + sw > vw) sw = vw - sx;
        if (sy + sh > vh) sh = vh - sy;
        if (sw <= 0 || sh <= 0) return;

        // Read force_size settings and compute the output dimensions
        const { forceSize, customShort, customLong, customWidth, customHeight, sizeMultiple } = getForceSizeConfig();
        const target = computeTargetSize(sw, sh, forceSize,
            (forceSize === "自定义宽高") ? customWidth : customShort,
            (forceSize === "自定义宽高") ? customHeight : customLong,
            sizeMultiple);

        // When "自定义宽高" specifies both W and H, apply an aspect-preserving
        // center-crop FIRST so the image isn't stretched to the exact target.
        if (forceSize === "自定义宽高" && customWidth > 0 && customHeight > 0) {
            const acrop = computeAspectCropPixels(sw, sh, target.w, target.h);
            if (!(acrop.sx === 0 && acrop.sy === 0 && acrop.sw === sw && acrop.sh === sh)) {
                // Adjust the source region to include the aspect crop
                sx += acrop.sx;
                sy += acrop.sy;
                sw = acrop.sw;
                sh = acrop.sh;
            }
        }

        // Draw to canvas at the target output size
        const canvas = document.createElement("canvas");
        canvas.width = target.w;
        canvas.height = target.h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(srcEl, sx, sy, sw, sh, 0, 0, target.w, target.h);

        // Copy to clipboard
        canvas.toBlob((blob) => {
            if (!blob) return;
            try {
                navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]).then(() => {
                    // Brief success feedback: flash green
                    screenshotBtn.classList.add("zyf-screenshot-btn--success");
                    setTimeout(() => {
                        screenshotBtn.classList.remove("zyf-screenshot-btn--success");
                    }, 600);
                }).catch(() => {
                    // Clipboard API may fail (e.g. no focus); silently ignore
                });
            } catch (err) {
                // Older browsers without ClipboardItem; silently ignore
            }
        }, "image/png");
    });
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        screenshotBtn.addEventListener(ev, (e) => e.stopPropagation());
    });

    // Reset button: restore cx=0, cy=0, cw=1, ch=1 (original size).
    // We intentionally do NOT close the crop overlay afterwards so
    // the user can keep adjusting if the reset was accidental. They
    // can click the scissors button to close.
    resetBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isVisible) return;
        writeWidgets(0, 0, 1, 1);
        safeRender();
    });
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        resetBtn.addEventListener(ev, (e) => e.stopPropagation());
    });

    // Public API
    previewWidget.cropOverlay = {
        show: () => setVisible(true),
        hide: () => setVisible(false),
        toggle: () => setVisible(!isVisible),
        isVisible: () => isVisible,
        // Always render so the badge and (when re-shown) the box reflect
        // the latest widget values, even while the overlay is closed.
        syncFromWidgets: () => safeRender(),
        refresh: () => safeRender(),
    };
}


// Utility
function updateSliderValues(widget, node, currentFrame, totalFrames) {
    if (!totalFrames || totalFrames <= 0) {
        totalFrames = 1;
    }
    const clampedCurrent = clamp(currentFrame ?? 1, 1, totalFrames);
    const existingValue = widget.value && typeof widget.value === "object" ? widget.value : {};
    widget.value = {
        ...existingValue,
        current: (clampedCurrent / totalFrames) * 100,
        currentFrame: clampedCurrent,
        totalFrames,
    };
    widget.label = `Frame: ${clampedCurrent} / ${totalFrames}`;
    requestNodeRedraw(node);
}

function getDoubleSliderWidgets(node) {
    if (!node) {
        return [];
    }
    const widgets = [];
    if (Array.isArray(node.widgets)) {
        for (const widget of node.widgets) {
            if (!widget) {
                continue;
            }
            if (widget.type === "double_slider" || widget.name === "in_out_point_slider") {
                widgets.push(widget);
            }
        }
    }
    if (node.doubleSliderWidget && !widgets.includes(node.doubleSliderWidget)) {
        widgets.push(node.doubleSliderWidget);
    }
    return widgets;
}

function getPrimaryDoubleSliderWidget(node) {
    const widgets = getDoubleSliderWidgets(node);
    if (!widgets.length) {
        return null;
    }
    const withFrames = widgets.find((widget) => widget?.value?.totalFrames);
    return withFrames ?? widgets[0];
}

function getTotalFramesFromNode(node) {
    const stateTotal = node?._zyfFrameState?.totalFrames;
    const sliderWidget = getPrimaryDoubleSliderWidget(node);
    const sliderTotal = sliderWidget?.value?.totalFrames;
    const paramsTotal = node?.previewWidget?.value?.params?.totalFrames;
    return Math.max(1, stateTotal ?? sliderTotal ?? paramsTotal ?? 1);
}

function setWidgetValue(node, widget, value) {
    if (!widget) {
        return;
    }
    const targetNode = node ?? widget.node;
    const canvas = app?.canvas;
    if (widget.setValue && targetNode && canvas) {
        const previousGuard = targetNode._zyfSuppressWidgetCallbacks;
        targetNode._zyfSuppressWidgetCallbacks = true;
        try {
            widget.setValue(value, { e: null, node: targetNode, canvas });
        } catch (err) {
            console.warn("zyf-video setWidgetValue fallback", err);
        } finally {
            targetNode._zyfSuppressWidgetCallbacks = previousGuard;
        }
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
    targetNode?.graph?.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
}

function placeWidgetAfter(node, widgetToMove, referenceWidget) {
    if (!node || !Array.isArray(node.widgets) || !widgetToMove || !referenceWidget) {
        return;
    }
    const widgets = node.widgets;
    const moveIndex = widgets.indexOf(widgetToMove);
    const refIndex = widgets.indexOf(referenceWidget);
    if (moveIndex === -1 || refIndex === -1) {
        return;
    }
    if (moveIndex === refIndex + 1) {
        return;
    }
    widgets.splice(moveIndex, 1);
    const currentRefIndex = widgets.indexOf(referenceWidget);
    widgets.splice(currentRefIndex + 1, 0, widgetToMove);
}

// 2026-07-27: 帧间隔 widget 上移到预览容器正上方。
// LiteGraph/widgets 的渲染顺序由 node.widgets 数组的顺序决定,
// addWidget 默认追加到末尾。本函数把 widgetToMove 移到
// referenceWidget 之前,保证最终顺序是 ... → referenceWidget
// (相对位置不变),实现"插入到指定 widget 之前"的效果。
function placeWidgetBefore(node, widgetToMove, referenceWidget) {
    if (!node || !Array.isArray(node.widgets) || !widgetToMove || !referenceWidget) {
        return;
    }
    const widgets = node.widgets;
    const moveIndex = widgets.indexOf(widgetToMove);
    const refIndex = widgets.indexOf(referenceWidget);
    if (moveIndex === -1 || refIndex === -1) {
        return;
    }
    if (moveIndex === refIndex - 1) {
        return;
    }
    widgets.splice(moveIndex, 1);
    const currentRefIndex = widgets.indexOf(referenceWidget);
    if (currentRefIndex === -1) {
        return;
    }
    widgets.splice(currentRefIndex, 0, widgetToMove);
}

function ensureFrameState(node) {
    if (!node._zyfFrameState) {
        node._zyfFrameState = {
            totalFrames: 1,
            frameRate: 1,
            currentFrame: 1,
            inPoint: 1,
            outPoint: 1,
            // 2026-07-13: 当前帧 widget 已移除,改为用 state 标志记录
            // "是否已经被用户/播放触碰过"。在 applyFrameState 中,只要 source
            // 不是 init/error,就把这个标志置 true(等价于旧版
            // hostNode.currentFrameWidget.value != -1 的检查)。
            _zyfUserCustomized: false,
            _lastChanged: "init",
            // 2026-07-14: "开始帧 / 结束帧 / 帧间隔"三项的持久化记忆字段。
            //   _zyfUserInPoint       = 上次用户设置的开始帧(绝对 1-indexed)
            //   _zyfUserOutCount      = 上次用户设置的结束帧显示值
            //                            (= outPoint - inPoint + 1,即结束帧 widget 的当前值)
            //   _zyfUserFrameInterval = 上次用户设置的帧间隔
            // 这三个值在用户主动调整(不是 init / error)时被写入,
            // 下次拖入新视频时由 loadedmetadata 处理器根据新视频的
            // totalFrames 判断"记忆值是否仍适用",适用则沿用,
            // 不适用则回归默认值(开始帧=1, 结束帧=totalFrames, 帧间隔=1)
            // 并把记忆字段清空,避免后续误用。
            _zyfUserInPoint: null,
            _zyfUserOutCount: null,
            _zyfUserFrameInterval: null,
        };
    }
    return node._zyfFrameState;
}

function normalizeFrameState(state) {
    state.totalFrames = Math.max(1, Math.floor(state.totalFrames || 1));
    // 2026-07-13: inPoint 和 outPoint 互相不能穿越对方 —— 区间至少要有
    // 1 帧(outPoint >= inPoint + 1,即 count >= 2)。这里用一个干净的两步
    // clamp 直接保证 inPoint < outPoint 恒成立,免去 _lastChanged 方向判断:
    //   - inPoint 上界压到 totalFrames - 1(给 outPoint 留位置)
    //   - outPoint 下界抬到 inPoint + 1
    // 这样无论用户怎么调,区间始终非空。
    // 退化情况:totalFrames = 1 时 inPoint < outPoint 不可满足(都只能 = 1),
    // 此时退回到原始的"两者都 = 1"行为,避免 clamp 上下界互换返回错值。
    if (state.totalFrames >= 2) {
        state.inPoint = clamp(Math.floor(state.inPoint || 1), 1, state.totalFrames - 1);
        state.outPoint = clamp(
            Math.floor(state.outPoint || state.totalFrames),
            state.inPoint + 1,
            state.totalFrames,
        );
    } else {
        state.inPoint = 1;
        state.outPoint = 1;
    }
    state.currentFrame = clamp(Math.floor(state.currentFrame || 1), 1, state.totalFrames);
}

function applyFrameState(node, updates, options = {}) {
    const state = ensureFrameState(node);
    const nextState = {
        ...state,
        ...updates,
    };
    if (options.source) {
        nextState._lastChanged = options.source;
        // 2026-07-13: 标记"已被用户/播放触碰过"。init 和 error 来自首次加载
        // /加载失败,不算用户交互;其他源(sync、currentFrame、inPoint、
        // outPoint、play 循环触发的 sync 等)都算。
        if (options.source !== "init" && options.source !== "error") {
            nextState._zyfUserCustomized = true;
        }
    }
    // 2026-07-13: "开始帧"和"结束帧"是两个**独立**的绝对帧位,
    // 不再做 outPoint 跟随 inPoint 的 auto-track。
    // 区间总帧数 = outPoint - inPoint + 1,由 timeline 标签按需计算。
    normalizeFrameState(nextState);

    // 2026-07-13: 当用户显式修改了 inPoint/outPoint 时,即使
    // normalizeFrameState 把值 clamp 回了旧值,也不能 early return
    // —— 因为 widget 可能已经显示了用户输入但被 clamp 掉的原始值,
    // 必须走完后续的 setWidgetValue 流程把 widget 纠正回正确值。
    // 否则会出现"数值乱跳且进度条不动"的 bug:用户输入 count=500 →
    // setOutPoint 转 absolute=539 → normalizeFrameState clamp 回
    // 464 → early return → widget 停留在 500,进度条 marker 停在 464。
    const hasExplicitInOut = updates.inPoint !== undefined || updates.outPoint !== undefined;
    if (!options.force && !hasExplicitInOut
        && state.totalFrames === nextState.totalFrames
        && state.frameRate === nextState.frameRate
        && state.currentFrame === nextState.currentFrame
        && state.inPoint === nextState.inPoint
        && state.outPoint === nextState.outPoint) {
        return;
    }

    Object.assign(state, nextState);

    // 2026-07-14: 持久化记忆(第二版 —— "非默认值才记,默认值要清空")。
    // 用户描述的核心需求是:只有"用户主动改到非默认"的值才需要跨视频
    // 记忆;如果改回了默认值(开始帧=1 或 结束帧=视频总帧),这就是默认
    // 状态,绝不能污染下次拖入的新视频 —— 否则会变成"以后每拖一个新
    // 视频都会按上一次的总帧记忆"。此外,"开始帧"和"结束帧"的判断是
    // 独立的(谁不是默认值就记谁,不是"两个都达到才算"),所以下面分两
    // 个独立的 if 分支,各自保存/清空各自的记忆字段,互不影响。
    if (options.source !== "init" && options.source !== "error") {
        if (updates.inPoint !== undefined && Number.isFinite(state.inPoint)) {
            if (state.inPoint !== 1) {
                // 非默认(用户改过):保存到记忆
                state._zyfUserInPoint = state.inPoint;
            } else {
                // 回到默认值 1:清空记忆,避免污染下次新视频
                state._zyfUserInPoint = null;
            }
        }
        if (updates.outPoint !== undefined
            && Number.isFinite(state.outPoint)
            && Number.isFinite(state.inPoint)
            && Number.isFinite(state.totalFrames)) {
            // 结束帧的"默认值"是 absolute outPoint === totalFrames。
            // 等价地说,count 默认值是 totalFrames - inPoint + 1。
            // 注意:count 的"默认值"会随 inPoint 变,所以记忆里只
            // 保存非默认情况下的 count,默认情况下清空记忆。
            if (state.outPoint !== state.totalFrames) {
                // 非默认(用户改过):保存到记忆(以 count 形式)
                state._zyfUserOutCount = Math.max(2, (state.outPoint || 0) - (state.inPoint || 0) + 1);
            } else {
                // 回到默认值(结束帧=总帧):清空记忆,避免污染下次新视频
                state._zyfUserOutCount = null;
            }
        }
    }

    if (updates.totalFrames !== undefined || updates.inPoint !== undefined || updates.outPoint !== undefined) {
        // 2026-07-13: 两个 widget 的边界互相联动,保证 inPoint < outPoint 恒成立:
        //   - 结束帧 widget 显示 count = outPoint - inPoint + 1,
        //     min = 2(count 至少 2,对应 outPoint >= inPoint + 1),
        //     max = totalFrames - inPoint + 1。
        //   - 开始帧 widget 显示 absolute inPoint,
        //     min = 1, max = outPoint - 1(inPoint 不能越过 outPoint)。
        // 任何一边的更新都会触发这一段,所以拖两个 marker / 改两个 widget 都安全。
        const totalFrames = state.totalFrames;
        const inPointClamped = clamp(state.inPoint, 1, totalFrames);
        const outPointClamped = clamp(state.outPoint, inPointClamped + 1, totalFrames);
        if (node.inPointWidget?.options) {
            node.inPointWidget.options.min = 1;
            // inPoint 不能等于 outPoint,所以 max = outPoint - 1
            node.inPointWidget.options.max = Math.max(1, outPointClamped - 1);
        }
        if (node.outPointWidget?.options) {
            node.outPointWidget.options.min = 2; // count >= 2
            node.outPointWidget.options.max = Math.max(2, totalFrames - inPointClamped + 1);
        }
    }

    if (node.previewWidget?.value?.params) {
        if (updates.totalFrames) {
            node.previewWidget.value.params.totalFrames = state.totalFrames;
        }
        if (updates.frameRate) {
            node.previewWidget.value.params.frameRate = state.frameRate;
        }
    }

    const sliderWidgets = getDoubleSliderWidgets(node);
    for (const sliderWidget of sliderWidgets) {
        const existingValue = sliderWidget.value && typeof sliderWidget.value === "object" ? sliderWidget.value : {};
        sliderWidget.value = {
            ...existingValue,
            startMarkerFrame: state.inPoint,
            endMarkerFrame: state.outPoint,
            currentFrame: state.currentFrame,
            totalFrames: state.totalFrames,
            frameRate: state.frameRate,
        };
        updateSliderValues(sliderWidget, node, state.currentFrame, state.totalFrames);
    }

    // 2026-07-13: 当前帧 widget 已移除,state.currentFrame 仍由
    // setCurrentFrame / 播放循环 / 进度条拖动维护。FrameInfoUnpack
    // 的"当前帧(初始)"输出端通过 slider_data.currentFrame 兜底。
    if (node.inPointWidget) setWidgetValue(node, node.inPointWidget, state.inPoint);
    // 2026-07-13: 结束帧 widget 显示的是 count = outPoint - inPoint + 1。
    // 内部 state.outPoint 仍是绝对结束帧位,但 widget 读到的必须是 count。
    if (node.outPointWidget) {
        const outCount = Math.max(1, (state.outPoint || 0) - (state.inPoint || 0) + 1);
        setWidgetValue(node, node.outPointWidget, outCount);
    }
    if (node.timelineWidget?.update) {
        node.timelineWidget.update(state);
    }
    requestNodeRedraw(node);

    // 更新分段计划显示
    if (typeof node._zyfUpdateSegmentCount === "function") {
        node._zyfUpdateSegmentCount();
    }

    if (options.updateVideo && node.previewWidget?.videoEl) {
        node.previewWidget.videoEl.setCurrentFrame(state.currentFrame, { silent: true, skipAudio: options.skipAudio });
    }
}

function syncTimelineFromVideo(node) {
    if (!node?.previewWidget?.videoEl) {
        return;
    }
    const totalFrames = getTotalFramesFromNode(node);
    const currentFrame = clamp(node.previewWidget.videoEl.getCurrentFrame(), 1, totalFrames);
    const inPoint = clamp(node.previewWidget.videoEl.getInPointFrame(), 1, totalFrames);
    const outPoint = clamp(node.previewWidget.videoEl.getOutPointFrame(), 1, totalFrames);
    applyFrameState(node, {
        totalFrames,
        currentFrame,
        inPoint,
        outPoint,
    }, { source: "sync" });
}

function updatePlayPauseControl(previewWidget, playerControlsWidget) {
    isVideoPlaying(previewWidget)
        ? setPlayIcon(playerControlsWidget)
        : setPauseIcon(playerControlsWidget);
}

function setPlayIcon(playerControlsWidget) {
    const imageHTML = `<img class="player-grid-item" src="${zyfGetUrl("../images/play.png", import.meta.url)}" />`;
    assignPlayPauseControlImage(playerControlsWidget, imageHTML);
}

function setPauseIcon(playerControlsWidget) {
    const imageHTML = `<img class="player-grid-item" src="${zyfGetUrl("../images/pause.png", import.meta.url)}" />`;
    assignPlayPauseControlImage(playerControlsWidget, imageHTML);
}

function assignPlayPauseControlImage(playerControlsWidget, imageHTML) {
    playerControlsWidget.controlsEl.children[PlayerControls.playPause].innerHTML = imageHTML;
    playerControlsWidget.controlsEl.children[PlayerControls.playPause].style.opacity = 1.0;
}

function isVideoPlaying(previewWidget) {
    return !(previewWidget.videoEl.paused || previewWidget.videoEl.ended);
}

function pauseVideoIfPlaying(previewWidget, playerControlsWidget) {
    if (!isVideoPlaying(previewWidget)) {
        return;
    }
    updatePlayPauseControl(previewWidget, playerControlsWidget);
    previewWidget.videoEl.pause();
}

let pauseListenerRegistered = false; // unused, kept for compatibility
export function isVideoLoaderNode(node) {
    if (!node) {
        return false;
    }
    const comfyClass = node.comfyClass ?? "";
    const type = node.type ?? "";
    return comfyClass.includes("zyf加载视频")
        || comfyClass.includes("ZyfVideoLoader")
        || type.includes("ZyfVideoLoader");
}

function getVideoLoaderNodes() {
    return app?.graph?._nodes?.filter((node) => isVideoLoaderNode(node)) ?? [];
}

function setWaitingForOtherPause(activeNode, enabled) {
    // Removed: pause feature has been deleted for a more compact UI.
}

function getNodeByUid(uid) {
    const graph = app?.graph;
    if (!graph) {
        return null;
    }
    const direct = graph._nodes_by_id?.[uid];
    if (direct) {
        return direct;
    }
    const nodes = graph._nodes ?? [];
    const target = String(uid);
    return nodes.find((node) => String(node?.id) === target) ?? null;
}

function getSingleVideoLoaderNode() {
    const nodes = getVideoLoaderNodes();
    return nodes.length === 1 ? nodes[0] : null;
}
function registerPauseListener() {
    // Removed: pause feature has been deleted for a more compact UI.
}

async function sendPauseResponse(node, { special } = {}) {
    // Removed: pause feature has been deleted for a more compact UI.
}


/*
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):
*/
function createUploadWidget(hostNode, pathWidget) {
    const fileInput = document.createElement("input");
    Object.assign(fileInput, {
        type: "file",
        accept: "video/webm,video/mp4,video/mkv",
        style: "display: none",
        onchange: async () => {
            if (fileInput.files.length) {
                if (await zyfUploadFile(fileInput.files[0]) != 200) {
                    //upload failed and file can not be added to options
                    return;
                }
                const filename = fileInput.files[0].name;
                const fullFilePath = `${filename}`;
                if (Array.isArray(pathWidget?.options?.values)) {
                    if (!pathWidget.options.values.includes(fullFilePath)) {
                        pathWidget.options.values.push(fullFilePath);
                        pathWidget.options.values.sort();
                    }
                }
                setWidgetValue(hostNode, pathWidget, fullFilePath);
                if (pathWidget.callback) {
                    pathWidget.callback(fullFilePath)
                }
            }
        },
    });
    document.body.append(fileInput);
    let uploadWidget = hostNode.addWidget("button", "choose video to upload", "image", () => {
        //clear the active click event
        app.canvas.node_widget = null

        fileInput.click();
    });
    uploadWidget.options.serialize = false;
    uploadWidget._zyfFileInput = fileInput;
    return uploadWidget;
}

/*
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):
*/
function injectHidden(widget) {
    widget.computeSize = (target_width) => {
        if (widget.hidden) {
            return [0, 0];
        }
        return [target_width, 20];
    };
    widget.computeLayoutSize = () => ({
        minWidth: 0,
        minHeight: 0,
        maxWidth: 0,
        maxHeight: 0,
    });
    widget.draw = () => {};
    widget.mouse = () => true;
    widget._type = widget.type
    Object.defineProperty(widget, "type", {
        set : function(value) {
            widget._type = value;
        },
        get : function() {
            if (widget.hidden) {
                return "hidden";
            }
            return widget._type;
        }
    });
    widget.hidden = true;
}

function hideWidgetVisually(widget) {
    if (!widget) {
        return;
    }
    enableHiddenTypeToggle(widget);
    widget.hidden = widget.hidden ?? true;
    if (!widget._zyfOriginalComputeSize) {
        widget._zyfOriginalComputeSize = widget.computeSize?.bind(widget);
    }
    if (!widget._zyfOriginalDraw) {
        widget._zyfOriginalDraw = widget.draw?.bind(widget);
    }
    if (!widget._zyfOriginalMouse) {
        widget._zyfOriginalMouse = widget.mouse?.bind(widget);
    }
    widget.computeSize = (target_width) => {
        if (widget.hidden) {
            return [0, 0];
        }
        if (widget._zyfOriginalComputeSize) {
            return widget._zyfOriginalComputeSize(target_width);
        }
        return [target_width, LiteGraph.NODE_WIDGET_HEIGHT];
    };
    // Only wrap custom draw/mouse handlers when they already exist.
    // For default LiteGraph widgets, overriding draw/mouse can hide visuals while keeping hit area active.
    if (widget._zyfOriginalDraw) {
        widget.draw = (ctx, node, widget_width, y, widget_height) => {
            if (widget.hidden) {
                return;
            }
            return widget._zyfOriginalDraw(ctx, node, widget_width, y, widget_height);
        };
    }
    if (widget._zyfOriginalMouse) {
        widget.mouse = function () {
            if (widget.hidden) {
                return true;
            }
            return widget._zyfOriginalMouse(...arguments);
        };
    }
    widget.serialize = true;
    applyWidgetVisibility(widget);
}

export function enableHiddenTypeToggle(widget) {
    if (!widget || widget._zyfHiddenTypeToggle) {
        return;
    }
    widget._zyfHiddenTypeToggle = true;
    widget._zyfOriginalType = widget.type;
    Object.defineProperty(widget, "type", {
        get() {
            if (widget.hidden && !widget._zyfKeepTypeOnHide) {
                return "hidden";
            }
            return widget._zyfOriginalType;
        },
        set(value) {
            widget._zyfOriginalType = value;
        },
    });
}

function applyWidgetVisibility(widget) {
    if (!widget) {
        return;
    }
    const el = widget.inputEl || widget.input || widget.el || widget.element;
    if (!el || !el.style) {
        return;
    }
    if (widget.hidden) {
        el.style.display = "none";
        el.style.pointerEvents = "none";
        el.style.height = "0px";
        el.style.width = "0px";
    } else {
        el.style.display = "";
        el.style.pointerEvents = "";
        el.style.height = "";
        el.style.width = "";
    }
}

export function setWidgetHidden(widget, hidden) {
    if (!widget) {
        return;
    }
    enableHiddenTypeToggle(widget);
    widget.hidden = hidden;
    applyWidgetVisibility(widget);
}

export function setWidgetDisabled(widget, disabled) {
    if (!widget) {
        return;
    }
    widget.disabled = disabled;
    if (widget.options) {
        widget.options.read_only = disabled;
    }
    widget._disabled = disabled;
    if (disabled) {
        if (!widget._zyfOriginalCallback && widget.callback) {
            widget._zyfOriginalCallback = widget.callback;
        }
        if (widget._zyfDisabledValue === undefined) {
            widget._zyfDisabledValue = widget.value;
        }
        widget.callback = function () {
            if (widget._zyfDisabledValue !== undefined) {
                widget.value = widget._zyfDisabledValue;
            }
            widget.node?.graph?.setDirtyCanvas?.(true, true);
            app?.canvas?.setDirty?.(true, true);
        };
    } else if (widget._zyfOriginalCallback) {
        widget.callback = widget._zyfOriginalCallback;
        widget._zyfOriginalCallback = null;
        widget._zyfDisabledValue = null;
    }
    const el = widget.inputEl || widget.input || widget.el || widget.element;
    if (el && "disabled" in el) {
        el.disabled = disabled;
    }
    if (el && "tabIndex" in el) {
        if (disabled) {
            if (widget._zyfOriginalTabIndex === undefined) {
                widget._zyfOriginalTabIndex = el.tabIndex;
            }
            el.tabIndex = -1;
        } else if (widget._zyfOriginalTabIndex !== undefined) {
            el.tabIndex = widget._zyfOriginalTabIndex;
            widget._zyfOriginalTabIndex = undefined;
        }
    }
    if (el?.setAttribute) {
        if (disabled) {
            el.setAttribute("aria-disabled", "true");
        } else {
            el.removeAttribute("aria-disabled");
        }
    }
    if (el?.style) {
        el.style.opacity = disabled ? "0.6" : "";
        el.style.pointerEvents = disabled ? "none" : "";
        el.style.cursor = disabled ? "not-allowed" : "";
    }
}

function forceHiddenWidget(widget) {
    if (!widget) {
        return;
    }
    injectHidden(widget);
    widget.hidden = true;
    widget.type = "hidden";
    widget.height = 0;
    if (widget.inputEl?.style) {
        widget.inputEl.style.display = "none";
        widget.inputEl.style.position = "absolute";
        widget.inputEl.style.left = "-99999px";
        widget.inputEl.style.top = "0px";
        widget.inputEl.style.opacity = "0";
        widget.inputEl.style.pointerEvents = "none";
        widget.inputEl.style.width = "0px";
        widget.inputEl.style.height = "0px";
        widget.inputEl.style.minHeight = "0px";
        widget.inputEl.style.minWidth = "0px";
    }
}

function updateCustomSizeLogic(sizeWidget, customShortWidget, customLongWidget, customWidthWidget, customHeightWidget, multipleWidget) {
    switch (sizeWidget.value) {
        case "自定义长边":
            if (customShortWidget) customShortWidget.hidden = true;
            if (customLongWidget) customLongWidget.hidden = false;
            if (customWidthWidget) customWidthWidget.hidden = true;
            if (customHeightWidget) customHeightWidget.hidden = true;
            if (multipleWidget) multipleWidget.hidden = false;
            break;
        case "自定义短边":
            if (customShortWidget) customShortWidget.hidden = false;
            if (customLongWidget) customLongWidget.hidden = true;
            if (customWidthWidget) customWidthWidget.hidden = true;
            if (customHeightWidget) customHeightWidget.hidden = true;
            if (multipleWidget) multipleWidget.hidden = false;
            break;
        case "自定义宽高":
            if (customShortWidget) customShortWidget.hidden = true;
            if (customLongWidget) customLongWidget.hidden = true;
            if (customWidthWidget) customWidthWidget.hidden = false;
            if (customHeightWidget) customHeightWidget.hidden = false;
            if (multipleWidget) multipleWidget.hidden = false;
            break;
        case "禁用":
        case "Disabled":
            if (customShortWidget) customShortWidget.hidden = true;
            if (customLongWidget) customLongWidget.hidden = true;
            if (customWidthWidget) customWidthWidget.hidden = true;
            if (customHeightWidget) customHeightWidget.hidden = true;
            if (multipleWidget) multipleWidget.hidden = true;
            break;
        default:
            // Preset sizes (480x?, ?x480, 480x480, etc.) — show multiplier,
            // hide all custom edge widgets.
            if (customShortWidget) customShortWidget.hidden = true;
            if (customLongWidget) customLongWidget.hidden = true;
            if (customWidthWidget) customWidthWidget.hidden = true;
            if (customHeightWidget) customHeightWidget.hidden = true;
            if (multipleWidget) multipleWidget.hidden = false;
            break;
    }
    if (customShortWidget) applyWidgetVisibility(customShortWidget);
    if (customLongWidget) applyWidgetVisibility(customLongWidget);
    if (customWidthWidget) applyWidgetVisibility(customWidthWidget);
    if (customHeightWidget) applyWidgetVisibility(customHeightWidget);
    if (multipleWidget) applyWidgetVisibility(multipleWidget);
}

function normalizePauseTimeoutWidget(node) {
    // Removed: pause feature has been deleted for a more compact UI.
}

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
        return input.links.some((linkId) => linkId !== null && linkId !== undefined);
    }
    return false;
}

function updateVideoInputAvailability(node) {
    if (!node) {
        return;
    }
    const hasImageInput = isInputConnected(node, "images");
    const hasAudioInput = isInputConnected(node, "audio");
    const previousState = node._zyfUsingImageInput;
    node._zyfUsingImageInput = hasImageInput;
    if (node.pathWidget) {
        if (!node.pathWidget._zyfHideReady) {
            hideWidgetVisually(node.pathWidget);
            node.pathWidget._zyfHideReady = true;
        }
        setWidgetHidden(node.pathWidget, hasImageInput);
        setWidgetDisabled(node.pathWidget, hasImageInput);
    }
    if (node.uploadWidget) {
        if (!node.uploadWidget._zyfHideReady) {
            hideWidgetVisually(node.uploadWidget);
            node.uploadWidget._zyfHideReady = true;
        }
        // 上传按钮已被顶部文件夹图标替代,始终隐藏
        setWidgetHidden(node.uploadWidget, true);
        setWidgetDisabled(node.uploadWidget, true);
    }
    if (!hasImageInput && node.previewWidget?.useVideoSource) {
        node.previewWidget.useVideoSource();
        if (previousState && node.pathWidget?.callback) {
            node.pathWidget.callback(node.pathWidget.value, true);
        }
    }
    if (node.previewWidget) {
        node._zyfUseVideoAudio = !hasImageInput && !hasAudioInput;
        if (node._zyfUseVideoAudio) {
            node.previewWidget._useVideoAudio = true;
            node.previewWidget.setAudioSourceFromVideo?.();
            node.previewWidget.requestVideoAudioPreview?.();
        } else if (!hasAudioInput) {
            node.previewWidget.clearAudioSource?.();
        }
    }
    // 同步顶部工具栏文件夹按钮可见性
    if (typeof node._zyfSyncFolderBtn === "function") {
        node._zyfSyncFolderBtn();
    }
    zyf_fitHeight(node);
    requestNodeRedraw(node);
}

function scheduleInputAvailabilitySync(node) {
    if (!node) {
        return;
    }
    if (node._zyfInputSyncTimer) {
        clearTimeout(node._zyfInputSyncTimer);
        node._zyfInputSyncTimer = null;
    }
    let attempts = 0;
    const tick = () => {
        attempts += 1;
        updateVideoInputAvailability(node);
        if (attempts < 20) {
            node._zyfInputSyncTimer = setTimeout(tick, 100);
        } else {
            node._zyfInputSyncTimer = null;
        }
    };
    tick();
}

function syncImageConnectionState(node) {
    if (!node) {
        return;
    }
    const connected = isInputConnected(node, "images");
    if (node._zyfLastImagesConnected !== connected) {
        node._zyfLastImagesConnected = connected;
        updateVideoInputAvailability(node);
    }
}

// Create widgets
export async function createVideoLoaderWidgets(nodeType) {
    if (nodeType?.prototype?._zyfWidgetLifecyclePatched) {
        return;
    }
    nodeType.prototype._zyfWidgetLifecyclePatched = true;

    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        originalNodeCreated?.apply(this, arguments);

        const that = this;
        this.applyFrameState = (updates, options = {}) => applyFrameState(this, updates, options);

        // Set a compact default size for new nodes so the plugin
        // starts at ~290×470 (width × height) instead of ComfyUI's
        // 320×200 default. The 290px width matches the minimum
        // enforced in setSize() (nodes.js) so the video preview +
        // crop toolbar fit on one row without the user having to
        // drag the node wider. The height is set to roughly match
        // the layout below (widgets + video preview + timeline).
        if (!Array.isArray(this.size) || this.size[0] < 290 || this.size[1] < 380) {
            const currentW = Array.isArray(this.size) ? this.size[0] : 320;
            const currentH = Array.isArray(this.size) ? this.size[1] : 200;
            const newW = Math.max(290, currentW);
            const newH = Math.max(380, currentH);
            // Defer the resize so it runs after LiteGraph has finished
            // its own setup (the widget layout would otherwise ignore
            // our setSize call). requestAnimationFrame is the standard
            // way to do this in ComfyUI extensions.
            requestAnimationFrame(() => {
                try {
                    this.setSize([newW, newH]);
                } catch (err) {
                    /* ignore — non-critical */
                }
            });
        }

        // Create double slider widget (hidden canvas store)
        const doubleSliderWidget = createDoubleSliderWidget(this, "in_out_point_slider");
        forceHiddenWidget(doubleSliderWidget);
        doubleSliderWidget.inputEl.style.display = "none";
        doubleSliderWidget.inputEl.style.pointerEvents = "none";
        this.doubleSliderWidget = doubleSliderWidget;
        updateSliderValues(doubleSliderWidget, this, 1, 1);

        // Add video preview widget first so widget callbacks can safely target it.
        const previewWidget = createVideoPreviewWidget(this);
        this.previewWidget = previewWidget;

        // Add timeline widget
        const timelineWidget = createTimelineWidget(this);
        this.timelineWidget = timelineWidget;

        // Pause controls removed for a more compact UI.
        this.pauseControlsWidget = createPauseControlsWidget(this);

        // Add path widget
        const pathWidget = this.widgets.find((w) => w.name === "视频路径");
        if (!pathWidget) {
            console.warn("zyf-video: 视频路径 widget not found during initialization");
            return;
        }
        pathWidget._zyfKeepTypeOnHide = true;
        setWidgetHidden(pathWidget, false);
        setWidgetDisabled(pathWidget, false);
        pathWidget.callback = (value, componentCreated) => {
            if (typeof componentCreated === "boolean" && componentCreated === true) {
                this.componentCreated = true;
            }
            else {
                this.componentCreated = false;
            }
            if (this._zyfUsingImageInput) {
                return;
            }
            if (!value) {
                that.previewWidget.updateParameters({});
                return;
            }
            
            let extension_index = value.lastIndexOf(".");
            let extension = value.slice(extension_index+1);
            let format = "video"
            format += "/" + extension;
            let params = {filename : value, type: "input", format: format};
            that.previewWidget.updateParameters(params);
        };
        this.pathWidget = pathWidget;

        // Add upload widget
        const uploadWidget = createUploadWidget(this, pathWidget);
        this.uploadWidget = uploadWidget;
        placeWidgetAfter(this, uploadWidget, pathWidget);

        const sizeWidget = this.widgets.find((w) => w.name === '强制尺寸');
        const customShortWidget = this.widgets.find((w) => w.name === '自定义短边');
        const customLongWidget = this.widgets.find((w) => w.name === '自定义长边');
        const customWidthWidget = this.widgets.find((w) => w.name === '自定义宽度');
        const customHeightWidget = this.widgets.find((w) => w.name === '自定义高度');
        const multipleWidget = this.widgets.find((w) => w.name === '图像尺寸倍数');
        let forceFrameRateWidget = this.widgets.find((w) => w.name === "强制帧率");
        const graphIdWidget = this.widgets.find((w) => w.name === 'graph_id');
        if (graphIdWidget) {
            hideWidgetVisually(graphIdWidget);
            graphIdWidget.hidden = true;
            setWidgetValue(this, graphIdWidget, `${app.graph?.id ?? ""}`);
            applyWidgetVisibility(graphIdWidget);
        }
        if (sizeWidget !== undefined) {
            hideWidgetVisually(customShortWidget);
            hideWidgetVisually(customLongWidget);
            hideWidgetVisually(customWidthWidget);
            hideWidgetVisually(customHeightWidget);
            hideWidgetVisually(multipleWidget);
            if (customShortWidget && (customShortWidget.value === null || customShortWidget.value === undefined)) {
                customShortWidget.value = customShortWidget.options?.default ?? 480;
            }
            if (customLongWidget && (customLongWidget.value === null || customLongWidget.value === undefined)) {
                customLongWidget.value = customLongWidget.options?.default ?? 832;
            }
            if (customWidthWidget && (customWidthWidget.value === null || customWidthWidget.value === undefined)) {
                customWidthWidget.value = customWidthWidget.options?.default ?? 480;
            }
            if (customHeightWidget && (customHeightWidget.value === null || customHeightWidget.value === undefined)) {
                customHeightWidget.value = customHeightWidget.options?.default ?? 832;
            }
            if (multipleWidget && (multipleWidget.value === null || multipleWidget.value === undefined)) {
                multipleWidget.value = multipleWidget.options?.default ?? "32";
            }
            sizeWidget.callback = (value) => {
                updateCustomSizeLogic(sizeWidget, customShortWidget, customLongWidget, customWidthWidget, customHeightWidget, multipleWidget);
                zyf_fitHeight(that);
            };
            updateCustomSizeLogic(sizeWidget, customShortWidget, customLongWidget, customWidthWidget, customHeightWidget, multipleWidget);
            zyf_fitHeight(that);
        }
        updateVideoInputAvailability(this);
        scheduleInputAvailabilitySync(this);

        // Add double slider widget (keep it hidden but serialized)
        document.body.appendChild(doubleSliderWidget.inputEl);
        const addedSliderWidget = this.addCustomWidget(doubleSliderWidget);
        const resolvedSliderWidgets = getDoubleSliderWidgets(this);
        const resolvedSliderWidget = addedSliderWidget ?? resolvedSliderWidgets[0] ?? doubleSliderWidget;
        for (const sliderWidget of resolvedSliderWidgets) {
            sliderWidget.inputEl = doubleSliderWidget.inputEl;
            sliderWidget.positionUpdatedCallback = doubleSliderWidget.positionUpdatedCallback;
            forceHiddenWidget(sliderWidget);
        }
        this.doubleSliderWidget = resolvedSliderWidget;

        // Create player controls widget
        const playerControlsWidget = createPlayerControlsWidget("player_controls", that, (control) => {
            switch (control) {
                case PlayerControls.setInPoint:
                    previewWidget.videoEl.setInPoint();
                    {
                        const sliderWidget = getPrimaryDoubleSliderWidget(that) ?? doubleSliderWidget;
                        // inPoint widget 显示 absolute inPoint。这里其实
                        // applyFrameState 已经把 widget 写过了,这里再写一次
                        // 主要是为了拿到 setValue 的 suppress 副作用,值是同一个。
                        setWidgetValue(that, that.inPointWidget, sliderWidget.value.startMarkerFrame);
                    }
                    syncTimelineFromVideo(that);
                    that.graph?.setDirtyCanvas(true, true);
                    break;
                case PlayerControls.gotoInPoint:
                    pauseVideoIfPlaying(previewWidget, playerControlsWidget);
                    previewWidget.videoEl.gotoInPoint();
                    syncTimelineFromVideo(that);
                    break;
                case PlayerControls.stepBackward:
                    pauseVideoIfPlaying(previewWidget, playerControlsWidget);
                    previewWidget.videoEl.regressOneFrame();
                    syncTimelineFromVideo(that);
                    break;
                case PlayerControls.playPause:
                    updatePlayPauseControl(previewWidget, playerControlsWidget);
                    if (!isVideoPlaying(previewWidget)) {
                        previewWidget.videoEl.play();
                    } else {
                        previewWidget.videoEl.pause();
                    }
                    syncTimelineFromVideo(that);
                    break;
                case PlayerControls.stepForward:
                    pauseVideoIfPlaying(previewWidget, playerControlsWidget);
                    previewWidget.videoEl.advanceOneFrame();
                    syncTimelineFromVideo(that);
                    break;
                case PlayerControls.gotoOutPoint:
                    pauseVideoIfPlaying(previewWidget, playerControlsWidget);
                    previewWidget.videoEl.gotoOutPoint();
                    syncTimelineFromVideo(that);
                    break;
                case PlayerControls.setOutPoint:
                    previewWidget.videoEl.setOutPoint();
                    {
                        const sliderWidget = getPrimaryDoubleSliderWidget(that) ?? doubleSliderWidget;
                        // 2026-07-13: 结束帧 widget 显示 count = outPoint - inPoint + 1,
                        // 不是 absolute。sliderWidget.value.endMarkerFrame 是
                        // absolute,需要先折算成 count 再 setWidgetValue。
                        const sliderEnd = sliderWidget.value.endMarkerFrame;
                        const sliderStart = sliderWidget.value.startMarkerFrame;
                        const outCount = Math.max(2, (sliderEnd || 0) - (sliderStart || 0) + 1);
                        setWidgetValue(that, that.outPointWidget, outCount);
                    }
                    syncTimelineFromVideo(that);
                    that.graph?.setDirtyCanvas(true, true);
                    break;
            }
        });
        this.playerControlsWidget = playerControlsWidget;

        // Add the trim controls. To keep the toolbar below the regular
        // widget list from being pushed off-screen, the in-point and
        // out-point widgets are intentionally placed next to the
        // 强制帧率 option in the regular widget rows, and the
        // 当前帧 / 帧间隔 controls are placed right under the player
        // controls toolbar.
        // Order: 开始帧 → 结束帧 → 帧间隔 (LiteGraph renders
        // widgets in the order they are added to node.widgets, so we
        // add them in the desired top-to-bottom order here.)
        // "当前帧" widget 已在 2026-07-13 移除;state.currentFrame 仍正常维护。
        //
        // 语义说明(2026-07-13):
        //   开始帧 (inPoint) = 源视频里的绝对起始帧(1-indexed)。
        //   结束帧 (outPoint) = 源视频里的绝对结束帧位(1-indexed,内部 state)。
        //   结束帧 widget 的"显示值" = outPoint - inPoint + 1,即"区间总帧数";
        //     用户编辑 widget 时,setOutPoint 会把 count 折算回绝对值再写入 state。
        //   二者夹出的播放区间 = [开始帧, 结束帧]。
        //   区间总帧数 = 结束帧 - 开始帧 + 1(由 timeline 标签和结束帧 widget 现算)。
        //   两个值**互相独立**:调整开始帧不会自动平移结束帧的绝对位,反之亦然;
        //     只会通过 count 公式让"结束帧 widget"这个显示值自动变化。
        //   播放时,视频将在 [开始帧, 结束帧] 之间无缝循环。
        //
        //   2026-07-13: 移除了"当前帧" widget(选项),但 state.currentFrame
        //   仍由 setCurrentFrame / 播放循环 / 进度条拖动维护,FrameInfoUnpack
        //   的"当前帧(初始)"输出端继续可用。
        const inPointWidget = this.addWidget("number", "开始帧", -1, (value) => {
            if (this._zyfSuppressWidgetCallbacks) {
                return;
            }
            previewWidget.videoEl.setInPoint(value);
        }, { min: 1, max: 1, step: 10, precision: 0 });
        this.inPointWidget = inPointWidget;

        const outPointWidget = this.addWidget("number", "结束帧", -1, (value) => {
            if (this._zyfSuppressWidgetCallbacks) {
                return;
            }
            previewWidget.videoEl.setOutPoint(value);
        }, { min: 1, max: 1, step: 10, precision: 0 });
        this.outPointWidget = outPointWidget;

        // Select every nth frame. The widget value itself is currently
        // a UI-side convenience (it does not change the underlying
        // frame state in this build), but the user still expects the
        // timeline label — which derives the displayed time from the
        // current 强制帧率 — to refresh whenever this widget is
        // edited. We therefore explicitly re-run the timeline update
        // against the latest `_zyfFrameState` on every change. If
        // future code adds real frame-interval semantics (e.g.
        // reducing totalFrames by N), the same hook here will keep
        // the label in sync without further changes.
        const selectEveryNthFrameWidget = this.addWidget("number", "帧间隔", 1, (value) => {
            if (this._zyfSuppressWidgetCallbacks) {
                return;
            }
            // 2026-07-14: 持久化记忆(第二版 —— "非默认值才记,默认值要清空")。
            // 帧间隔的默认值是 1,只有用户改到非 1 时才需要跨视频记忆;
            // 改回 1 时清空记忆,避免污染下次拖入的新视频(否则会按上次
            // 视频的总帧数推算间隔)。
            if (this._zyfFrameState) {
                if (Number(value) !== 1) {
                    this._zyfFrameState._zyfUserFrameInterval = value;
                } else {
                    this._zyfFrameState._zyfUserFrameInterval = null;
                }
            }
            if (this.timelineWidget?.update && this._zyfFrameState) {
                this.timelineWidget.update(this._zyfFrameState);
            }
            requestNodeRedraw(this);
        }, { min: 1, step: 10, precision: 0, tooltip: "每 N 帧抽一帧(预留设置)。改值后会立刻刷新进度条上的时间/帧显示,确保和'强制帧率'变更后的状态保持同步。" });
        this.selectEveryNthFrameWidget = selectEveryNthFrameWidget;

        // ========== 分段计划 ==========
        // 返回 <= s 且 >= minimum 的最大 8N+1 值
        const nextLower8n1 = (s, minimum = 33) => {
            if (s < minimum) return null;
            let n = Math.floor((s - 1) / 8);
            while (n >= 0) {
                const val = n * 8 + 1;
                if (val <= s && val >= minimum) return val;
                n--;
            }
            return null;
        };

        // 计算每段帧数(与Python端 _compute_segment_sizes 一致)
        // 规则:
        //   1. 前 count-1 段为 segLen,最后一段为剩余帧数。
        //   2. 若最后一段 < minLast,向左侧段借帧:被借段降到 <= 原值且 >= minLast
        //      的最大 8N+1 值(保持 8N+1 格式以兼容 WAN/LTX 模型),
        //      释放的帧数加到最后一段,直到最后一段 >= minLast。
        //   3. 最后一段**不强制** 8N+1 格式,只需 >= minLast,可以是 33/34/35/...
        //      任意整数(精确吃掉剩余帧,避免无意义截断)。
        // 帧数守恒: sum(sizes) === totalFrames。
        const computeSegmentSizes = (totalFrames, segLen, minLast = 33) => {
            if (totalFrames <= 0) return [0];
            if (segLen <= 0 || totalFrames <= segLen) return [totalFrames];
            const count = Math.max(1, Math.ceil(totalFrames / segLen));
            const sizes = new Array(count - 1).fill(segLen);
            sizes.push(totalFrames - (count - 1) * segLen);
            if (sizes[sizes.length - 1] >= minLast) return sizes;
            while (sizes[sizes.length - 1] < minLast && sizes.length > 1) {
                let borrowed = false;
                for (let i = sizes.length - 2; i >= 0; i--) {
                    const target = nextLower8n1(sizes[i] - 1, minLast);
                    if (target === null) continue;
                    const give = sizes[i] - target;
                    if (give <= 0) continue;
                    sizes[i] = target;
                    sizes[sizes.length - 1] += give;
                    borrowed = true;
                    break;
                }
                if (!borrowed) break;
            }
            return sizes;
        };

        // 计算当前分段数量
        const computeSegmentCount = () => {
            if (this.segmentPlanWidget?.value !== "启用") return 0;
            const outCount = Math.round(Number(this.outPointWidget?.value) || 0);
            const rawLen = Math.round(Number(this.segmentLengthWidget?.value) || 81);
            const segLen = Math.max(41, Math.min(99999, rawLen));
            if (outCount <= 0 || segLen <= 0) return 0;
            return computeSegmentSizes(outCount, segLen, 33).length;
        };

        // 更新分段数量显示(绘制在canvas上) + 钳位索引
        const updateSegmentCountDisplay = () => {
            const enabled = this.segmentPlanWidget?.value === "启用";
            const count = enabled ? computeSegmentCount() : 0;
            // 更新分段索引的最大值
            const maxIdx = Math.max(0, count - 1);
            if (this.segmentIndexWidget?.options) {
                this.segmentIndexWidget.options.max = maxIdx;
            }
            // 钳位当前索引值(当分段数减少导致当前索引超出范围时)
            if (this.segmentIndexWidget && count > 0) {
                const curIdx = Math.round(Number(this.segmentIndexWidget.value) || 0);
                if (curIdx > maxIdx) {
                    this._zyfSegmentIndexUpdating = true;
                    try {
                        this.segmentIndexWidget.setValue(maxIdx);
                    } finally {
                        this._zyfSegmentIndexUpdating = false;
                    }
                }
            }
            this._zyfSegmentCount = count;
            requestNodeRedraw(this);
            zyf_fitHeight(this);
        };

        // 分段计划开关 (使用combo以确保兼容性)
        const segmentPlanOptions = ["禁用", "启用"];
        const segmentPlanWidget = this.addWidget("combo", "分段计划", "禁用", (value) => {
            if (this._zyfSuppressWidgetCallbacks) return;
            const enabled = value === "启用";
            // 显示/隐藏子选项
            if (this.segmentLengthWidget) {
                setWidgetHidden(this.segmentLengthWidget, !enabled);
                setWidgetDisabled(this.segmentLengthWidget, !enabled);
            }
            if (this.segmentIndexWidget) {
                setWidgetHidden(this.segmentIndexWidget, !enabled);
                setWidgetDisabled(this.segmentIndexWidget, !enabled);
            }
            updateSegmentCountDisplay();
        }, { values: segmentPlanOptions, tooltip: "开启分段计划:将选中区间按指定长度拆分为多段,每次队列运行根据分段索引导出对应段。若最后一段不足33帧会自动向前几段借帧(被借段保持8N+1格式以兼容WAN/LTX,最后一段可以是任意>=33的整数,如33/34/35/...)。" });
        this.segmentPlanWidget = segmentPlanWidget;
        // 辅助方法:判断是否启用
        segmentPlanWidget._zyfIsEnabled = () => segmentPlanWidget.value === "启用";

        // 为整数number widget配置整数行为
        // 关键发现:ComfyUI的NumberWidget内部用 ge(options) = options.step2 || (options.step||10)*0.1
        // 计算步进值! 仅设置step:1实际步进为0.1,导致浮点数。必须设置step2=1。
        // precision默认是3(toFixed(3)显示3位小数),必须设为0。
        const setupIntWidget = (w, defaultVal, minVal, maxVal) => {
            if (!w) return;

            // 确保初始值为整数
            w.value = Math.max(minVal, Math.min(maxVal, Math.round(Number(w.value) || defaultVal)));

            // 关键:设置step2=1(实际步进单位),precision=0(整数显示)
            // ComfyUI内部getWidgetStep()返回 step2 || step*0.1,所以step2才是真正的步进值
            w.step = 1;
            w.step2 = 1;
            w.precision = 0;
            if (w.options) {
                w.options.step = 1;
                w.options.step2 = 1;
                w.options.precision = 0;
                w.options.round = 1;
                w.options.min = minVal;
                w.options.max = maxVal;
            }

            // 重写setValue:所有值设置时自动取整钳位(处理拖拽产生的浮点增量)
            const origSetValue = w.setValue?.bind(w);
            w.setValue = function(val, ctx) {
                const n = Math.max(minVal, Math.min(maxVal, Math.round(Number(val) || defaultVal)));
                if (origSetValue) {
                    origSetValue(n, ctx);
                } else {
                    w.value = n;
                }
            };

            // 延迟配置DOM input
            const configureInput = () => {
                if (!w.inputEl) {
                    requestAnimationFrame(configureInput);
                    return;
                }
                w.inputEl.type = "number";
                w.inputEl.step = "1";
                w.inputEl.min = String(minVal);
                w.inputEl.max = String(maxVal);
                w.inputEl.value = String(Math.round(Number(w.value) || defaultVal));
            };
            requestAnimationFrame(configureInput);
        };

        // 分段长度
        const segmentLengthWidget = this.addWidget("number", "分段长度", 81, (value) => {
            if (this._zyfSegmentLengthUpdating) return;
            this._zyfSegmentLengthUpdating = true;
            try {
                updateSegmentCountDisplay();
            } finally {
                this._zyfSegmentLengthUpdating = false;
            }
        }, { min: 41, max: 99999, step: 1, precision: 0, tooltip: "每段帧数(WAN推荐4的倍数+1),(LTX推荐8的倍数+1),最低41最高99999,默认81。若最后一段不足33帧会自动向前借帧(被借段保持8N+1格式,最后一段可以是任意>=33的整数,精确吃掉剩余帧)。最后几段可能低于设定值。" });
        this.segmentLengthWidget = segmentLengthWidget;
        setupIntWidget(segmentLengthWidget, 81, 41, 99999);

        // 分段索引
        const segmentIndexWidget = this.addWidget("number", "分段索引", 0, (value) => {
            if (this._zyfSegmentIndexUpdating) return;
            this._zyfSegmentIndexUpdating = true;
            try {
                updateSegmentCountDisplay();
            } finally {
                this._zyfSegmentIndexUpdating = false;
            }
        }, { min: 0, step: 1, precision: 0, tooltip: "当前要导出的分段索引(从 0 开始)。队列批量运行时,每次修改此值运行即可导出对应段。索引范围会根据分段数自动钳位。" });
        this.segmentIndexWidget = segmentIndexWidget;
        setupIntWidget(segmentIndexWidget, 0, 0, 99999);

        // 在分段长度widget行内绘制"共 X 段"提示:在标签文字右侧,数值输入框左侧,不遮挡任何内容
        const drawSegmentCount = (ctx, width, y) => {
            if (segmentPlanWidget?.value !== "启用") return;
            const count = this._zyfSegmentCount || 0;
            if (count <= 0) return;
            ctx.save();
            ctx.fillStyle = "#8a8a8a";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.font = "12px sans-serif";
            // 标签"分段长度"约占80px,x=95开始画不会和标题重合;同时远在数值输入框右侧区域之前
            const text = `共 ${count} 段`;
            const baseline = y + 10;
            ctx.fillText(text, 95, baseline);
            ctx.restore();
        };
        const origSegLenDrawWidget = segmentLengthWidget.drawWidget;
        const origSegLenDraw = segmentLengthWidget.draw;
        if (typeof origSegLenDrawWidget === "function") {
            segmentLengthWidget.drawWidget = function (ctx, opts) {
                const result = origSegLenDrawWidget.apply(this, arguments);
                const width = (opts && Number(opts.width)) || this.width || 0;
                drawSegmentCount(ctx, width, this.y);
                return result;
            };
        }
        if (typeof origSegLenDraw === "function") {
            segmentLengthWidget.draw = function (ctx, node, width, y, height, lowQuality) {
                const result = origSegLenDraw.apply(this, arguments);
                drawSegmentCount(ctx, width, y);
                return result;
            };
        }

        // 把update函数挂载到node上供applyFrameState调用
        this._zyfUpdateSegmentCount = updateSegmentCountDisplay;

        // 初始状态:禁用时分段长度/索引隐藏
        setWidgetHidden(segmentLengthWidget, true);
        setWidgetDisabled(segmentLengthWidget, true);
        setWidgetHidden(segmentIndexWidget, true);
        setWidgetDisabled(segmentIndexWidget, true);

        // 把所有参数widget放到预览之前
        // 放置顺序(每次placeWidgetBefore都插到ref正前方,最后放置的离ref最近):
        // 工具栏(通过unshift放到最顶) → 开始帧 → 结束帧 → 强制帧率 → 帧间隔 → 强制尺寸 → 分段计划 → 预览
        if (this.previewWidget) {
            // 开始帧/结束帧放在最靠前位置(始终可见)
            placeWidgetBefore(this, inPointWidget, this.previewWidget);
            placeWidgetBefore(this, outPointWidget, this.previewWidget);
            // 强制帧率
            if (forceFrameRateWidget) placeWidgetBefore(this, forceFrameRateWidget, this.previewWidget);
            // 帧间隔
            placeWidgetBefore(this, selectEveryNthFrameWidget, this.previewWidget);
            // 强制尺寸相关widgets
            if (sizeWidget) placeWidgetBefore(this, sizeWidget, this.previewWidget);
            if (customShortWidget) placeWidgetBefore(this, customShortWidget, this.previewWidget);
            if (customLongWidget) placeWidgetBefore(this, customLongWidget, this.previewWidget);
            if (customWidthWidget) placeWidgetBefore(this, customWidthWidget, this.previewWidget);
            if (customHeightWidget) placeWidgetBefore(this, customHeightWidget, this.previewWidget);
            if (multipleWidget) placeWidgetBefore(this, multipleWidget, this.previewWidget);
            // 分段计划widgets
            placeWidgetBefore(this, segmentPlanWidget, this.previewWidget);
            placeWidgetBefore(this, segmentLengthWidget, this.previewWidget);
            placeWidgetBefore(this, segmentIndexWidget, this.previewWidget);
        }

        // ========== 顶部工具栏(文件夹上传 + 折叠/展开按钮) ==========
        // 需折叠的参数widgets组:
        //   - 视频路径(pathWidget) 始终显示(ComfyUI combo控件有特殊DOM结构,
        //     强制隐藏会漏出内部按钮;且用户需要随时看到当前选中的视频),
        //     仅当 images 输入已连接(视频来自上游节点)时自动隐藏。
        //   - 其余所有参数(开始帧/结束帧/尺寸/帧率/分段等)全部在折叠时隐藏。
        const collapsibleWidgets = [
            inPointWidget,
            outPointWidget,
            sizeWidget,
            customShortWidget,
            customLongWidget,
            customWidthWidget,
            customHeightWidget,
            multipleWidget,
            forceFrameRateWidget,
            selectEveryNthFrameWidget,
            segmentPlanWidget,
            segmentLengthWidget,
            segmentIndexWidget,
        ].filter(Boolean);

        // 折叠状态:默认折叠(紧凑模式),从 node.properties 恢复持久化状态
        this._zyfParamsCollapsed = this.properties?._zyfParamsCollapsed !== false;

        // 统一保存折叠状态到 node.properties(随工作流序列化)
        const persistCollapsed = (collapsed) => {
            this._zyfParamsCollapsed = !!collapsed;
            try {
                if (!this.properties) this.properties = {};
                this.properties._zyfParamsCollapsed = this._zyfParamsCollapsed;
            } catch (e) {}
        };

        // 创建工具栏DOM
        const toolbarEl = document.createElement("div");
        toolbarEl.className = "zyf-top-toolbar";

        // 文件夹图标(上传按钮) - 描边风格
        const FOLDER_SVG = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
        // 折叠图标(向下箭头 ▼) / 展开图标(向上箭头 ▲)
        const CHEVRON_DOWN_SVG = `<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>`;
        const CHEVRON_UP_SVG = `<svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>`;

        const folderBtn = document.createElement("button");
        folderBtn.type = "button";
        folderBtn.className = "zyf-toolbar-btn";
        folderBtn.title = "上传视频文件";
        folderBtn.innerHTML = FOLDER_SVG;

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "zyf-toolbar-btn zyf-toggle-btn";
        toggleBtn.title = "展开/折叠参数设置";
        toggleBtn.innerHTML = CHEVRON_DOWN_SVG;

        // 右侧弹性占位
        const spacer = document.createElement("div");
        spacer.style.flex = "1";

        toolbarEl.appendChild(folderBtn);
        toolbarEl.appendChild(spacer);
        toolbarEl.appendChild(toggleBtn);

        const topToolbarWidget = this.addDOMWidget("zyf_top_toolbar", "top_toolbar", toolbarEl, {
            serialize: false,
            hideOnZoom: false,
        });
        topToolbarWidget.computeSize = function(width) {
            return [width, 26];
        };

        // 将工具栏放到最顶部(第一个widget位置)
        if (this.widgets && this.widgets.length > 0) {
            const firstWidget = this.widgets[0];
            if (firstWidget !== topToolbarWidget) {
                const idx = this.widgets.indexOf(topToolbarWidget);
                if (idx > 0) this.widgets.splice(idx, 1);
                this.widgets.unshift(topToolbarWidget);
            }
        }

        // 隐藏原始的"choose video to upload"按钮(由文件夹图标替代)
        if (uploadWidget) {
            setWidgetHidden(uploadWidget, true);
            setWidgetDisabled(uploadWidget, true);
        }

        // 设置一组widgets可见性
        const setGroupVisible = (widgets, visible) => {
            for (const w of widgets) {
                if (!w) continue;
                setWidgetHidden(w, !visible);
            }
        };

        // 应用折叠/展开状态
        const applyCollapseState = () => {
            const collapsed = this._zyfParamsCollapsed;
            // 视频路径始终根据 images 连接状态决定可见性(不受折叠影响)
            const hasImageInput = isInputConnected(this, "images");
            setWidgetHidden(pathWidget, hasImageInput);
            if (collapsed) {
                // 折叠:隐藏所有参数widgets(开始帧/结束帧/尺寸/帧率/分段等)
                setGroupVisible(collapsibleWidgets, false);
                toggleBtn.innerHTML = CHEVRON_DOWN_SVG;
                toggleBtn.title = "展开参数设置";
                toggleBtn.classList.remove("active");
            } else {
                // 展开:开始帧/结束帧始终显示
                if (inPointWidget) setWidgetHidden(inPointWidget, false);
                if (outPointWidget) setWidgetHidden(outPointWidget, false);
                // 显示强制尺寸(通过updateCustomSizeLogic管理子widget)
                setWidgetHidden(sizeWidget, false);
                updateCustomSizeLogic(sizeWidget, customShortWidget, customLongWidget, customWidthWidget, customHeightWidget, multipleWidget);
                // 显示强制帧率
                setWidgetHidden(forceFrameRateWidget, false);
                // 显示帧间隔
                setWidgetHidden(selectEveryNthFrameWidget, false);
                // 显示分段计划(通过其callback管理子widget)
                setWidgetHidden(segmentPlanWidget, false);
                const segEnabled = segmentPlanWidget?.value === "启用";
                if (segmentLengthWidget) {
                    setWidgetHidden(segmentLengthWidget, !segEnabled);
                    setWidgetDisabled(segmentLengthWidget, !segEnabled);
                }
                if (segmentIndexWidget) {
                    setWidgetHidden(segmentIndexWidget, !segEnabled);
                    setWidgetDisabled(segmentIndexWidget, !segEnabled);
                }
                updateSegmentCountDisplay();
                toggleBtn.innerHTML = CHEVRON_UP_SVG;
                toggleBtn.title = "折叠参数设置";
                toggleBtn.classList.add("active");
            }
            zyf_fitHeight(this);
        };

        // 文件夹按钮点击 -> 触发上传
        folderBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        folderBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (uploadWidget?._zyfFileInput) {
                app.canvas.node_widget = null;
                uploadWidget._zyfFileInput.click();
            }
        });

        // 折叠/展开按钮点击
        toggleBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            persistCollapsed(!this._zyfParamsCollapsed);
            applyCollapseState();
        });

        // 保存toolbar引用供onConfigure使用
        this._zyfTopToolbar = {
            widget: topToolbarWidget,
            folderBtn,
            toggleBtn,
            collapsibleWidgets,
            applyCollapseState,
        };

        // 根据images输入连接状态控制文件夹按钮可见性
        const syncFolderBtnVisibility = () => {
            const hasImageInput = isInputConnected(this, "images");
            if (folderBtn) {
                folderBtn.style.display = hasImageInput ? "none" : "";
                folderBtn.disabled = hasImageInput;
            }
        };
        this._zyfSyncFolderBtn = syncFolderBtnVisibility;
        syncFolderBtnVisibility();

        // 初始状态:折叠
        // 立即设置每个widget的.hidden标记(LiteGraph在create DOM时会读取此标记
        // 决定是否给元素加"litegraph-hidden"类),避免初次绘制时参数闪现。
        // 注意:pathWidget 不预标记hidden,由 applyCollapseState 根据 images 连接状态决定。
        if (this._zyfParamsCollapsed) {
            for (const w of collapsibleWidgets) {
                if (!w) continue;
                enableHiddenTypeToggle(w);
                w.hidden = true;
            }
        }
        applyCollapseState();
        // rAF 后再补一次:此时widget的inputEl/el已被LiteGraph创建,
        // applyWidgetVisibility 可以正确设置 display:none,防止初次创建节点时
        // 参数在折叠状态下短暂可见。
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.removed) return;
                applyCollapseState();
            });
        });

        // 监听开始帧/结束帧变化,更新分段数显示
        const origInPointCallback = inPointWidget.callback;
        inPointWidget.callback = function (value) {
            if (origInPointCallback) origInPointCallback.apply(this, arguments);
            updateSegmentCountDisplay();
        };
        const origOutPointCallback = outPointWidget.callback;
        outPointWidget.callback = function (value) {
            if (origOutPointCallback) origOutPointCallback.apply(this, arguments);
            updateSegmentCountDisplay();
        };

        // Freeform crop box (0.0-1.0 normalized). Create hidden widgets
        // that store the crop values and sync with the overlay UI.
        const hideCropWidget = (w) => {
            if (!w) return;
            w.hidden = true;
            w.serialize = true;
            try { w.type = "hidden"; } catch (err) { /* ignore */ }
            w.computeSize = () => [0, -4];
            try { w.draw = () => {}; } catch (err) { /* ignore */ }
            try { w.mouse = () => true; } catch (err) { /* ignore */ }
        };
        
        const cropXWidget = this.addWidget("number", "裁剪X", 0.0, (value) => {
            if (this._zyfSuppressWidgetCallbacks) return;
            previewWidget.cropOverlay?.syncFromWidgets();
        }, { min: 0.0, max: 1.0, step: 0.001, precision: 3 });
        hideCropWidget(cropXWidget);
        
        const cropYWidget = this.addWidget("number", "裁剪Y", 0.0, (value) => {
            if (this._zyfSuppressWidgetCallbacks) return;
            previewWidget.cropOverlay?.syncFromWidgets();
        }, { min: 0.0, max: 1.0, step: 0.001, precision: 3 });
        hideCropWidget(cropYWidget);
        
        const cropWWidget = this.addWidget("number", "裁剪W", 1.0, (value) => {
            if (this._zyfSuppressWidgetCallbacks) return;
            previewWidget.cropOverlay?.syncFromWidgets();
        }, { min: 0.02, max: 1.0, step: 0.001, precision: 3 });
        hideCropWidget(cropWWidget);
        
        const cropHWidget = this.addWidget("number", "裁剪H", 1.0, (value) => {
            if (this._zyfSuppressWidgetCallbacks) return;
            previewWidget.cropOverlay?.syncFromWidgets();
        }, { min: 0.02, max: 1.0, step: 0.001, precision: 3 });
        hideCropWidget(cropHWidget);
        
        this.cropXWidget = cropXWidget;
        this.cropYWidget = cropYWidget;
        this.cropWWidget = cropWWidget;
        this.cropHWidget = cropHWidget;

        // Force frame rate widget (0 = auto / use video's original, 1-60 = force)
        forceFrameRateWidget = this.widgets.find((w) => w.name === "强制帧率");
        if (forceFrameRateWidget) {
            this.forceFrameRateWidget = forceFrameRateWidget;
            // Track the last-known "original" frame rate & total frames so we can
            // recompute totalFrames on the fly when the user changes force_frame_rate.
            this._zyfOriginalFrameRate = forceFrameRateWidget.value || 0;
            this._zyfOriginalTotalFrames = 0;
            // -- "Original FPS" indicator -----------------------------------
            // The user wants to see the video's *original* frame rate next
            // to the force-frame-rate value, with a small arrow / spacing
            // and a gray font, so they can tell at a glance what they're
            // overriding. The widget value itself is the forced fps (or
            // 0 = auto), and it is already in-memory persistent across
            // video loads (LiteGraph holds the value on the node). The
            // original fps comes from `hostNode._zyfOriginalFrameRate`
            // which is set by the file-info / video-loaded callback.
            //
            // We wrap the widget's `drawWidget` (or legacy `draw`) so
            // that AFTER the base widget paints, we draw a small
            // gray "原始 24.0 ←" label on the left side of the widget
            // row (the ← sits at the end, closer to the forced fps value
            // on the right). The base widget still uses its own padding
            // / fonts, so we just restore the canvas state and overlay
            // our text.
            const drawOriginalFpsIndicator = (ctx, width, y) => {
                const origFps = Number(this._zyfOriginalFrameRate);
                if (!Number.isFinite(origFps) || origFps <= 0) {
                    return;
                }
                // Format with up to 2 decimals, drop trailing zeros.
                let origLabel;
                if (Number.isInteger(origFps)) {
                    origLabel = String(origFps);
                } else {
                    origLabel = origFps.toFixed(2).replace(/\.?0+$/, "");
                }
                const text = `原始 ${origLabel} ←`;
                ctx.save();
                ctx.fillStyle = "#8a8a8a";      // gray, matches LiteGraph label
                ctx.textAlign = "right";
                ctx.textBaseline = "middle";
                // Anchor the text to the *right* end at ~85px from the
                // widget's right edge so it sits between the
                // "强制帧率" label (which starts at the left margin)
                // and the value (which is right-aligned to the right
                // edge with ~30px reserved for it). With a 280px-wide
                // widget row this gives the indicator roughly
                // x ≈ width - 85 ≈ 195 — well clear of both the label
                // and the value, with a small arrow gap.
                const rightX = Math.max(120, width - 85);
                const baseline = y + 10;        // ~middle of 20px widget height
                ctx.fillText(text, rightX, baseline);
                ctx.restore();
            };
            const originalDrawWidget = forceFrameRateWidget.drawWidget;
            const originalDraw = forceFrameRateWidget.draw;
            // Wrap whichever draw surface the widget actually exposes.
            // NumberWidget (modern) uses `drawWidget(ctx, opts)`. Legacy
            // custom widgets use `draw(ctx, node, width, y, height, lq)`.
            if (typeof originalDrawWidget === "function") {
                forceFrameRateWidget.drawWidget = function (ctx, opts) {
                    const result = originalDrawWidget.apply(this, arguments);
                    const width = (opts && Number(opts.width)) || this.width || (this.graph && this.graph.size && this.size && this.size[0]) || 0;
                    drawOriginalFpsIndicator(ctx, width, this.y);
                    return result;
                };
            }
            if (typeof originalDraw === "function") {
                forceFrameRateWidget.draw = function (ctx, node, width, y, height, lowQuality) {
                    const result = originalDraw.apply(this, arguments);
                    drawOriginalFpsIndicator(ctx, width, y);
                    return result;
                };
            }
            // _zyfRecomputingForceFrameRate guards against recursive recomputation
            // when applyFrameState() programmatically writes the widget value back.
            this._zyfRecomputingForceFrameRate = false;
            this._recomputeForceFrameRate = () => {
                if (this._zyfSuppressWidgetCallbacks || this._zyfRecomputingForceFrameRate) {
                    return;
                }
                const params = this.previewWidget?.value?.params || {};
                const widgetValue = Number(forceFrameRateWidget.value);
                const origFps = Number(params.originalFrameRate ?? this._zyfOriginalFrameRate ?? 0);
                const origTotal = Number(params.originalTotalFrames ?? this._zyfOriginalTotalFrames ?? 0);
                if (!Number.isFinite(origFps) || origFps <= 0) {
                    return;
                }
                const isAuto = !Number.isFinite(widgetValue) || widgetValue <= 0;
                const forcedFps = isAuto ? origFps : Math.max(1, Math.min(60, widgetValue));
                const originalDuration = origFps > 0 ? origTotal / origFps : 0;
                const newTotal = originalDuration > 0
                    ? Math.max(1, Math.round(originalDuration * forcedFps))
                    : Math.max(1, origTotal);
                const currentFrameState = this._zyfFrameState;
                const prevFrame = currentFrameState?.currentFrame ?? 1;
                this._zyfRecomputingForceFrameRate = true;
                try {
                    applyFrameState(this, {
                        frameRate: forcedFps,
                        totalFrames: newTotal,
                        currentFrame: clamp(prevFrame, 1, newTotal),
                    }, { source: "forceFrameRate", force: true });
                } finally {
                    this._zyfRecomputingForceFrameRate = false;
                }
                // Keep the image-sequence player in sync with the (possibly new) frame rate,
                // so that currentTime/duration calculations stay correct after a force change.
                const sequencePlayer = this.previewWidget?.sequencePlayer;
                if (sequencePlayer) {
                    sequencePlayer.frameRate = forcedFps;
                    sequencePlayer.frameDuration = forcedFps ? 1 / forcedFps : 0;
                }
                // Programmatically resync the widget value to the clamped forced fps
                // without re-entering recompute (guarded by _zyfRecomputingForceFrameRate).
                // Only update the widget when the user has set a non-zero value (forced mode).
                // When widgetValue <= 0 (auto), preserve the "0 = auto" semantics so the
                // widget value persists across video loads.
                if (widgetValue > 0 && forceFrameRateWidget.value !== forcedFps) {
                    this._zyfSuppressWidgetCallbacks = true;
                    try {
                        forceFrameRateWidget.value = forcedFps;
                        if (forceFrameRateWidget.inputEl && "value" in forceFrameRateWidget.inputEl) {
                            forceFrameRateWidget.inputEl.value = forcedFps;
                        }
                    } finally {
                        this._zyfSuppressWidgetCallbacks = false;
                    }
                }
            };
            forceFrameRateWidget.callback = (value) => this._recomputeForceFrameRate();
        }

        // Make sure to reload video after refreshing
        setTimeout(() => {
            pathWidget.callback(pathWidget.value, true);
            updateVideoInputAvailability(this);
            scheduleInputAvailabilitySync(this);
            this.graph?.setDirtyCanvas(true, true);
        }, 10);

        // Cleanup
        this.serialize_widgets = true;

        const originalOnRemoved = this.onRemoved;
        this.onRemoved = function () {
            originalOnRemoved?.apply(this, arguments);
            doubleSliderWidget.inputEl.remove();
            if (this.uploadWidget?._zyfFileInput) {
                this.uploadWidget._zyfFileInput.remove();
            }
        };
        // Compact default size: aim for a narrow, short node so it doesn't
        // dominate the ComfyUI canvas. LiteGraph enforces node.minSize
        // when the user (or auto-layout) resizes. The toolbar inside
        // the node is built on a 1fr grid so the buttons reflow with
        // the node width — the user can shrink the node as small as
        // they like and the controls will keep working.
        if (!this.size || this.size.length < 2 || this.size[0] <= 0 || this.size[1] <= 0) {
            this.size = [...this.size || []];
        }
        const computed = this.computeSize();
        this.size[0] = Math.max(this.size[0] || 0, 140);
        this.size[1] = Math.max(this.size[1] || 0, computed[1] || 0);
        this.minSize = [140, computed[1] || 0];
        this.setSize(this.size);
    };

    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info, input) {
        originalOnConnectionsChange?.apply(this, arguments);
        const inputName = input?.name ?? this.inputs?.[index]?.name;
        if (inputName === "audio" && !connected) {
            this.previewWidget?.clearAudioSource?.();
        }
        updateVideoInputAvailability(this);
        if (inputName === "images" && connected) {
            scheduleInputAvailabilitySync(this);
        }
    };

    const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
        const result = originalOnDrawForeground?.apply(this, arguments);
        syncImageConnectionState(this);
        return result;
    };

    // Loading serialized data
    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
        originalOnConfigure?.apply(this, arguments);

        const sizeWidget = this.widgets.find((w) => w.name === '强制尺寸');
        const customShortWidget = this.widgets.find((w) => w.name === '自定义短边');
        const customLongWidget = this.widgets.find((w) => w.name === '自定义长边');
        const customWidthWidget = this.widgets.find((w) => w.name === '自定义宽度');
        const customHeightWidget = this.widgets.find((w) => w.name === '自定义高度');
        const multipleWidget = this.widgets.find((w) => w.name === '图像尺寸倍数');
        const graphIdWidget = this.widgets.find((w) => w.name === 'graph_id');
        if (graphIdWidget) {
            hideWidgetVisually(graphIdWidget);
            graphIdWidget.hidden = true;
            setWidgetValue(this, graphIdWidget, `${app.graph?.id ?? ""}`);
            applyWidgetVisibility(graphIdWidget);
        }
        if (sizeWidget !== undefined) {
            if (customShortWidget && (customShortWidget.value === null || customShortWidget.value === undefined)) {
                setWidgetValue(this, customShortWidget, customShortWidget.options?.default ?? 480);
            }
            if (customLongWidget && (customLongWidget.value === null || customLongWidget.value === undefined)) {
                setWidgetValue(this, customLongWidget, customLongWidget.options?.default ?? 832);
            }
            if (customWidthWidget && (customWidthWidget.value === null || customWidthWidget.value === undefined)) {
                setWidgetValue(this, customWidthWidget, customWidthWidget.options?.default ?? 480);
            }
            if (customHeightWidget && (customHeightWidget.value === null || customHeightWidget.value === undefined)) {
                setWidgetValue(this, customHeightWidget, customHeightWidget.options?.default ?? 832);
            }
            if (multipleWidget && (multipleWidget.value === null || multipleWidget.value === undefined)) {
                setWidgetValue(this, multipleWidget, multipleWidget.options?.default ?? "32");
            }
            updateCustomSizeLogic(sizeWidget, customShortWidget, customLongWidget, customWidthWidget, customHeightWidget, multipleWidget);
        }
        updateVideoInputAvailability(this);
        scheduleInputAvailabilitySync(this);

        // 恢复分段计划显示状态
        if (this.segmentPlanWidget) {
            const enabled = this.segmentPlanWidget.value === "启用";
            if (this.segmentLengthWidget) {
                setWidgetHidden(this.segmentLengthWidget, !enabled);
                setWidgetDisabled(this.segmentLengthWidget, !enabled);
            }
            if (this.segmentIndexWidget) {
                setWidgetHidden(this.segmentIndexWidget, !enabled);
                setWidgetDisabled(this.segmentIndexWidget, !enabled);
            }
            if (typeof this._zyfUpdateSegmentCount === "function") {
                requestAnimationFrame(() => {
                    this._zyfSuppressWidgetCallbacks = true;
                    try {
                        this._zyfUpdateSegmentCount();
                    } finally {
                        this._zyfSuppressWidgetCallbacks = false;
                    }
                });
            }
        }

        // 应用顶部工具栏折叠状态:优先从 node.properties 恢复持久化状态
        // (工作流加载/页面切换后保持用户上次的展开/折叠选择),
        // 若没有持久化值(新节点),默认折叠。
        if (this._zyfTopToolbar) {
            const saved = info?.properties?._zyfParamsCollapsed;
            this._zyfParamsCollapsed = saved === undefined ? true : !!saved;
            try {
                if (!this.properties) this.properties = {};
                this.properties._zyfParamsCollapsed = this._zyfParamsCollapsed;
            } catch (e) {}
            this._zyfTopToolbar.applyCollapseState();
        } else {
            zyf_fitHeight(this);
        }
    };
}

/*
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):
*/
export function zyf_fitHeight(node) {
    if (!node || node._zyfFitInProgress) {
        return;
    }
    node._zyfFitInProgress = true;
    try {
        const newHeight = node.computeSize([node.size[0], node.size[1]])[1];
        if (Math.abs((node.size[1] || 0) - newHeight) > 0.5) {
            node.setSize([node.size[0], newHeight]);
        }
        requestNodeRedraw(node);
    } finally {
        node._zyfFitInProgress = false;
    }
}

function requestNodeRedraw(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    node?.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
    if (node?.graph) {
        node.graph._version = (node.graph._version ?? 0) + 1;
    }
}

// ============================================================================
// 2026-07-15 — zyf 风格预览小组件(供 zyf保存视频复用)
//
// 设计目标:不依赖 inPointWidget / outPointWidget / doubleSliderWidget
// 这套加载视频专属的状态机。所有 UI 行为只围绕一个 videoEl + audioEl
// 展开,样式直接命中 zyfNodes.css 里的同名 class,所以视觉与
// zyf加载视频的"截屏按钮 / 裁剪按钮 / 音频控件 / 进度条"完全一致。
// ============================================================================

/**
 * zyf 风格"截屏当前帧"按钮。点击后把 videoEl 当前帧画到 canvas,
 * 转 PNG 写入剪贴板。和 zyf加载视频里那个截屏按钮共用同一个 class
 * (.zyf-screenshot-btn),所以位置/颜色/悬停效果自动一致。
 */
export function createZYFStyleScreenshotButton(parentEl, getSourceEl) {
    const SCREENSHOT_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <line x1="3" y1="3" x2="21" y2="3"/>
            <line x1="3" y1="3" x2="3" y2="6"/>
            <line x1="21" y1="3" x2="21" y2="6"/>
            <line x1="6" y1="7" x2="18" y2="19"/>
            <line x1="18" y1="7" x2="6" y2="19"/>
            <circle cx="6" cy="19" r="2.2"/>
            <circle cx="18" cy="19" r="2.2"/>
        </svg>`;
    const btn = document.createElement("button");
    btn.className = "zyf-screenshot-btn";
    btn.title = "截屏当前帧到剪贴板";
    btn.innerHTML = `<span class="zyf-screenshot-btn-icon">${SCREENSHOT_SVG}</span>`;
    btn.setAttribute("aria-label", "截屏当前帧");
    parentEl.appendChild(btn);

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const srcEl = typeof getSourceEl === "function" ? getSourceEl() : null;
        if (!srcEl) return;
        const vw = srcEl.videoWidth || srcEl.naturalWidth || 0;
        const vh = srcEl.videoHeight || srcEl.naturalHeight || 0;
        if (!vw || !vh) return;
        if (srcEl.tagName === "VIDEO" && srcEl.readyState < 2) return;
        const canvas = document.createElement("canvas");
        canvas.width = vw;
        canvas.height = vh;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(srcEl, 0, 0, vw, vh);
        canvas.toBlob((blob) => {
            if (!blob) return;
            try {
                navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]).then(() => {
                    btn.classList.add("zyf-screenshot-btn--success");
                    setTimeout(() => btn.classList.remove("zyf-screenshot-btn--success"), 600);
                }).catch(() => { /* 剪贴板 API 失败(无焦点)静默忽略 */ });
            } catch (err) { /* 旧浏览器没有 ClipboardItem,静默忽略 */ }
        }, "image/png");
    });
    // 阻止冒泡到 LiteGraph canvas,避免触发节点拖拽 / 画布平移。
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        btn.addEventListener(ev, (e) => e.stopPropagation());
    });
    return btn;
}

/**
 * zyf 风格音频控件:右下角扬声器按钮 + 鼠标悬停展开音量条。
 * 与 zyf加载视频里那个 .zyf-audio-control 共用同一份 CSS,
 * 所以外观、动画、悬停行为完全一致。getAudioEl() 返回当前
 * 节点 <audio> 元素(可能 null)。
 */
export function createZYFStyleAudioControl(parentEl, getAudioEl) {
    const SPEAKER_SVG = `<path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>`;
    const MUTED_SVG = `<path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>`;

    const container = document.createElement("div");
    container.className = "zyf-audio-control";
    container.style.position = "absolute";
    container.style.right = "6px";
    container.style.bottom = "6px";
    container.style.zIndex = "9999";
    container.style.pointerEvents = "auto";
    container.style.touchAction = "none";
    container.title = "音频控制(点击切换静音 / 拖动调整音量)";
    container.setAttribute("aria-label", "音频控制");
    container.innerHTML = `
        <div class="zyf-audio-panel">
            <input type="range" class="zyf-audio-volume-slider"
                   min="0" max="1" step="0.01" value="0.8"
                   aria-label="音量" title="音量滑块" tabindex="-1" />
            <button type="button" class="zyf-audio-toggle" aria-label="切换静音" title="切换静音 / 取消静音">
                <svg class="zyf-audio-icon-speaker" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${SPEAKER_SVG}</svg>
                <svg class="zyf-audio-icon-muted" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${MUTED_SVG}</svg>
            </button>
        </div>`;
    parentEl.appendChild(container);

    const button = container.querySelector(".zyf-audio-toggle");
    const slider = container.querySelector(".zyf-audio-volume-slider");
    let muted = false;
    let volume = 0.8;
    const applyToAudio = () => {
        const audio = typeof getAudioEl === "function" ? getAudioEl() : null;
        if (!audio) return;
        audio.muted = muted;
        audio.volume = Math.max(0, Math.min(1, volume));
    };
    const setMutedVisual = () => button.classList.toggle("zyf-audio-muted", muted);
    setMutedVisual();
    applyToAudio();

    const shouldStop = (event) => event.target === container;
    ["click", "mousedown", "pointerdown"].forEach((ev) => {
        container.addEventListener(ev, (event) => {
            if (shouldStop(event)) event.stopPropagation();
        }, true);
    });
    container.addEventListener("dblclick", (event) => {
        event.preventDefault();
        if (shouldStop(event)) event.stopPropagation();
    }, true);
    container.addEventListener("wheel", (event) => {
        if (shouldStop(event)) event.stopPropagation();
    }, true);
    container.addEventListener("contextmenu", (event) => {
        if (shouldStop(event)) event.stopPropagation();
    }, true);

    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        muted = !muted;
        setMutedVisual();
        applyToAudio();
        container.classList.add("zyf-audio-active");
    });
    slider.addEventListener("input", (event) => {
        volume = parseFloat(event.target.value);
        if (volume > 0 && muted) {
            muted = false;
            setMutedVisual();
        }
        applyToAudio();
    });
    slider.addEventListener("mousedown", (event) => event.stopPropagation());
    slider.addEventListener("pointerdown", (event) => event.stopPropagation());
    slider.addEventListener("click", (event) => event.stopPropagation());

    let leaveTimer = null;
    container.addEventListener("mouseover", () => {
        if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
        container.classList.add("zyf-audio-active");
    });
    container.addEventListener("mouseout", (event) => {
        if (container.contains(event.relatedTarget)) return;
        if (leaveTimer) clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => container.classList.remove("zyf-audio-active"), 220);
    });
    return {
        element: container,
        setMuted: (v) => { muted = !!v; setMutedVisual(); applyToAudio(); },
        setVolume: (v) => { volume = Math.max(0, Math.min(1, Number(v) || 0)); slider.value = String(volume); applyToAudio(); },
        applyToAudio,
    };
}

/**
 * zyf 风格"裁剪到剪贴板"按钮:点击后用 onApply 回调获取裁剪参数
 * {cx, cy, cw, ch}(归一化),截取视频当前帧的指定区域到剪贴板。
 * 如果 onApply 返回 null(未裁剪),则截全图。
 */
export function createZYFStyleCropButton(parentEl, getSourceEl, getCrop) {
    const CROP_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 2v14a2 2 0 0 0 2 2h14"/>
            <path d="M18 22V8a2 2 0 0 0-2-2H2"/>
            <line x1="15" y1="3" x2="21" y2="3"/>
            <line x1="21" y1="3" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="3" y2="21"/>
            <line x1="3" y1="21" x2="3" y2="15"/>
            <line x1="7" y1="17" x2="17" y2="7"/>
        </svg>`;
    const btn = document.createElement("button");
    btn.className = "zyf-crop-toggle";
    btn.title = "裁剪当前帧到剪贴板";
    btn.innerHTML = `<span class="zyf-crop-toggle-icon">${CROP_SVG}</span>`;
    btn.setAttribute("aria-label", "裁剪当前帧");
    parentEl.appendChild(btn);

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const srcEl = typeof getSourceEl === "function" ? getSourceEl() : null;
        if (!srcEl) return;
        const vw = srcEl.videoWidth || srcEl.naturalWidth || 0;
        const vh = srcEl.videoHeight || srcEl.naturalHeight || 0;
        if (!vw || !vh) return;
        if (srcEl.tagName === "VIDEO" && srcEl.readyState < 2) return;
        const crop = (typeof getCrop === "function" ? getCrop() : null) || { cx: 0, cy: 0, cw: 1, ch: 1 };
        let sx = Math.round((crop.cx || 0) * vw);
        let sy = Math.round((crop.cy || 0) * vh);
        let sw = Math.round((crop.cw || 1) * vw);
        let sh = Math.round((crop.ch || 1) * vh);
        if (sx < 0) { sw += sx; sx = 0; }
        if (sy < 0) { sh += sy; sy = 0; }
        if (sx + sw > vw) sw = vw - sx;
        if (sy + sh > vh) sh = vh - sy;
        if (sw <= 0 || sh <= 0) return;
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(srcEl, sx, sy, sw, sh, 0, 0, sw, sh);
        canvas.toBlob((blob) => {
            if (!blob) return;
            try {
                navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => {
                    btn.classList.add("zyf-screenshot-btn--success");
                    setTimeout(() => btn.classList.remove("zyf-screenshot-btn--success"), 600);
                }).catch(() => {});
            } catch (err) {}
        }, "image/png");
    });
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        btn.addEventListener(ev, (e) => e.stopPropagation());
    });
    return btn;
}

/**
 * zyf 风格进度条。基于 videoEl 的 timeupdate 事件自动更新,
 * 拖动跳转,样式与 zyf加载视频完全一致。
 */
export function createZYFStyleTimeline(hostNode) {
    const element = document.createElement("div");
    element.className = "zyf-timeline";
    element.style.marginTop = "0";
    element.style.marginBottom = "0";
    element.style.padding = "0";

    const trackEl = document.createElement("div");
    trackEl.className = "zyf-timeline-track";
    trackEl.style.cursor = "pointer";

    const fillEl = document.createElement("div");
    fillEl.className = "zyf-timeline-fill";
    trackEl.appendChild(fillEl);

    const currentMarkerEl = document.createElement("div");
    currentMarkerEl.className = "zyf-timeline-marker zyf-timeline-marker-current";
    trackEl.appendChild(currentMarkerEl);

    const labelFrameEl = document.createElement("span");
    labelFrameEl.className = "zyf-timeline-label-frame";
    const labelSepEl = document.createElement("span");
    labelSepEl.className = "zyf-timeline-label-sep";
    labelSepEl.textContent = "\u00b7";
    const labelTimeEl = document.createElement("span");
    labelTimeEl.className = "zyf-timeline-label-time";
    const labelEl = document.createElement("div");
    labelEl.className = "zyf-timeline-label";
    labelEl.appendChild(labelFrameEl);
    labelEl.appendChild(labelSepEl);
    labelEl.appendChild(labelTimeEl);
    trackEl.appendChild(labelEl);

    element.appendChild(trackEl);

    const widget = hostNode.addDOMWidget("timeline_widget", "zyf_timeline_widget", element, {
        serialize: false,
        hideOnZoom: false,
    });
    widget.computeSize = (width) => [width, 20];

    let videoEl = null;
    let frameRate = 30;
    let totalFrames = 1;
    let rafId = null;
    let lastRafTime = -1;

    const formatTime = (sec) => {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = sec - m * 60;
        const rounded = Math.round(s * 10) / 10;
        const whole = Math.floor(rounded);
        const tenths = Math.round((rounded - whole) * 10);
        return `${m}:${String(whole).padStart(2, "0")}.${tenths}`;
    };

    // Use totalFrames / frameRate as the authoritative total duration.
    // videoEl.duration (browser-reported media duration) can differ from
    // the expected value due to encoding quirks (e.g. audio track shorter
    // than video track, last-frame rounding). Fall back to videoEl.duration
    // only when frame count / rate info is unavailable.
    const getTotalDuration = () => {
        if (totalFrames > 0 && frameRate > 0) {
            return totalFrames / frameRate;
        }
        if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
            return videoEl.duration;
        }
        return 0;
    };

    const update = () => {
        if (!videoEl || !Number.isFinite(videoEl.duration) || videoEl.duration <= 0) {
            fillEl.style.width = "0%";
            fillEl.style.left = "0%";
            currentMarkerEl.style.left = "0%";
            labelFrameEl.textContent = "F 0/0";
            labelTimeEl.textContent = "T 0:00.0/0:00.0";
            return;
        }
        const dur = getTotalDuration();
        if (dur <= 0) {
            fillEl.style.width = "0%";
            fillEl.style.left = "0%";
            currentMarkerEl.style.left = "0%";
            labelFrameEl.textContent = "F 0/0";
            labelTimeEl.textContent = "T 0:00.0/0:00.0";
            return;
        }
        const cur = videoEl.currentTime || 0;
        const pct = Math.max(0, Math.min(1, cur / dur)) * 100;
        fillEl.style.left = "0%";
        fillEl.style.width = `${pct}%`;
        currentMarkerEl.style.left = `${pct}%`;
        const curFrame = Math.max(1, Math.min(totalFrames, Math.round(cur * frameRate) + 1));
        labelFrameEl.textContent = `F ${curFrame}/${totalFrames}`;
        labelTimeEl.textContent = `T ${formatTime(cur)}/${formatTime(dur)}`;
    };

    // rAF loop: 播放时 60fps 驱动,停播时自动退出
    const startRaf = () => {
        if (rafId) return;
        lastRafTime = -1;
        const tick = () => {
            if (!videoEl || videoEl.paused || videoEl.ended) {
                rafId = null;
                return;
            }
            if (videoEl.currentTime !== lastRafTime) {
                lastRafTime = videoEl.currentTime;
                update();
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    };

    const stopRaf = () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        update();
    };

    const attach = (vEl, opts = {}) => {
        detach();
        videoEl = vEl;
        if (opts.frameRate) frameRate = Number(opts.frameRate) || 30;
        if (opts.totalFrames) totalFrames = Number(opts.totalFrames) || 1;
        videoEl.addEventListener("timeupdate", update);
        videoEl.addEventListener("loadedmetadata", update);
        videoEl.addEventListener("seeked", update);
        videoEl.addEventListener("play", startRaf);
        videoEl.addEventListener("pause", stopRaf);
        videoEl.addEventListener("ended", stopRaf);
        update();
        if (!videoEl.paused) startRaf();
    };

    const detach = () => {
        stopRaf();
        if (!videoEl) return;
        videoEl.removeEventListener("timeupdate", update);
        videoEl.removeEventListener("loadedmetadata", update);
        videoEl.removeEventListener("seeked", update);
        videoEl.removeEventListener("play", startRaf);
        videoEl.removeEventListener("pause", stopRaf);
        videoEl.removeEventListener("ended", stopRaf);
    };

    // 拖动跳转: pointerdown 在 trackEl, pointermove/pointerup 挂 window
    // 每次 pointermove 都更新视觉位置(fill/marker/label),但 video seek
    // 做节流(约 100ms 间隔) —— 避免快拖时大量 seek 排队造成卡顿,
    // 同时慢拖/停顿时画面仍能及时更新到当前帧。
    let dragging = false;
    let dragPointerId = null;
    let lastSeekTime = 0;
    let pendingSeekRatio = null;
    const SEEK_THROTTLE_MS = 100;
    const getSeekRatio = (event) => {
        const dur = getTotalDuration();
        if (!videoEl || dur <= 0) return null;
        const rect = trackEl.getBoundingClientRect();
        if (!rect.width) return null;
        const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        return x / rect.width;
    };
    const doSeek = (ratio) => {
        try {
            videoEl.currentTime = ratio * getTotalDuration();
        } catch (err) {}
        lastSeekTime = performance.now();
        pendingSeekRatio = null;
    };
    const seekTo = (event) => {
        const ratio = getSeekRatio(event);
        if (ratio === null) return;
        doSeek(ratio);
    };
    const updateDragVisual = (event) => {
        const ratio = getSeekRatio(event);
        if (ratio === null) return;
        const pct = ratio * 100;
        fillEl.style.left = "0%";
        fillEl.style.width = `${pct}%`;
        currentMarkerEl.style.left = `${pct}%`;
        const dur = getTotalDuration();
        const curTime = ratio * dur;
        const curFrame = Math.max(1, Math.min(totalFrames, Math.round(curTime * frameRate) + 1));
        labelFrameEl.textContent = `F ${curFrame}/${totalFrames}`;
        labelTimeEl.textContent = `T ${formatTime(curTime)}/${formatTime(dur)}`;
        // 节流 seek: 间隔足够才执行真正的视频跳转,否则标记待处理
        pendingSeekRatio = ratio;
        if (performance.now() - lastSeekTime >= SEEK_THROTTLE_MS) {
            doSeek(ratio);
        }
    };
    const onPointerMove = (event) => {
        if (!dragging) return;
        event.preventDefault();
        updateDragVisual(event);
    };
    const onPointerUp = (event) => {
        if (!dragging) return;
        dragging = false;
        try { trackEl.releasePointerCapture?.(dragPointerId); } catch {}
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        dragPointerId = null;
        // 拖拽结束: 如果有未执行的 seek,立即执行最终定位
        if (pendingSeekRatio !== null) {
            doSeek(pendingSeekRatio);
        }
    };
    trackEl.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        dragPointerId = event.pointerId;
        try { trackEl.setPointerCapture?.(event.pointerId); } catch {}
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp, { passive: false });
        window.addEventListener("pointercancel", onPointerUp, { passive: false });
        seekTo(event);
    });

    return { widget, attach, detach, update };
}

// ============================================================================
// zyf 风格自由裁剪 overlay(供 zyf保存视频复用)
// ============================================================================
// 完整移植自 zyf加载视频的 createCropOverlay,但把 crop 状态存储从
// "hostNode.cropXWidget / cropYWidget / cropWWidget / cropHWidget"
// 改为内存对象 { cx, cy, cw, ch }(归一化 0-1)。videoEl 和 parentEl
// 通过参数注入,不依赖 previewWidget._hostNode。

const _CROP_MIN_FRACTION = 0.02;
const _clampCropFraction = (v) => Math.max(0, Math.min(1, Number(v) || 0));

const _CROP_RATIOS = [
    { name: "Freeform",  val: 0 },
    { name: "Original",  val: -1 },
    { name: "1:1",       val: 1 },
    { name: "4:5",       val: 4 / 5 },
    { name: "5:4",       val: 5 / 4 },
    { name: "16:9",      val: 16 / 9 },
    { name: "9:16",      val: 9 / 16 },
    { name: "4:3",       val: 4 / 3 },
    { name: "3:4",       val: 3 / 4 },
    { name: "3:2",       val: 3 / 2 },
    { name: "2:3",       val: 2 / 3 },
];

export function createZYFStyleCropOverlay(parentEl, videoEl, params) {
    // params: { getCropState(): {cx,cy,cw,ch}, setCropState(cx,cy,cw,ch),
    //            getOutputPixelSize(): {w, h} }
    const getCropState = params.getCropState || (() => ({ cx: 0, cy: 0, cw: 1, ch: 1 }));
    const setCropState = params.setCropState || (() => {});
    const getOutputPixelSize = params.getOutputPixelSize || (() => {
        const w = videoEl?.videoWidth || 0;
        const h = videoEl?.videoHeight || 0;
        return { w, h };
    });

    // ---- Crop toggle button (top-right) ---------------------------------
    const CROP_TOGGLE_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 2v14a2 2 0 0 0 2 2h14"/>
            <path d="M18 22V8a2 2 0 0 0-2-2H2"/>
            <line x1="15" y1="3" x2="21" y2="3"/>
            <line x1="21" y1="3" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="3" y2="21"/>
            <line x1="3" y1="21" x2="3" y2="15"/>
            <line x1="7" y1="17" x2="17" y2="7"/>
        </svg>`;
    const toggle = document.createElement("button");
    toggle.className = "zyf-crop-toggle";
    toggle.title = "自由裁剪(在视频上拖拽框选区域,自由指定输出尺寸)";
    toggle.innerHTML = `<span class="zyf-crop-toggle-icon">${CROP_TOGGLE_SVG}</span>`;
    toggle.setAttribute("aria-label", "自由裁剪");
    parentEl.appendChild(toggle);

    // ---- Reset button (↺) ------------------------------------------------
    const RESET_SVG = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <polyline points="3 4 3 10 9 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 10"/>
        </svg>`;
    const resetBtn = document.createElement("button");
    resetBtn.className = "zyf-crop-reset";
    resetBtn.title = "恢复原始尺寸(清除裁剪框)";
    resetBtn.innerHTML = `<span class="zyf-crop-reset-icon">${RESET_SVG}</span>`;
    resetBtn.setAttribute("aria-label", "恢复原始尺寸");
    resetBtn.style.display = "none";
    parentEl.appendChild(resetBtn);

    // ---- Crop dims badge -------------------------------------------------
    const cropDimsLabel = document.createElement("span");
    cropDimsLabel.className = "zyf-crop-dims";
    cropDimsLabel.textContent = "";
    cropDimsLabel.style.display = "none";
    cropDimsLabel.title = "当前裁剪尺寸(像素)";
    parentEl.appendChild(cropDimsLabel);

    // ---- Toolbar ---------------------------------------------------------
    const toolbar = document.createElement("div");
    toolbar.className = "zyf-crop-toolbar";
    toolbar.style.display = "none";
    const arSelect = document.createElement("select");
    arSelect.className = "zyf-crop-ar";
    arSelect.title = "裁剪框宽高比";
    _CROP_RATIOS.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = String(r.val);
        opt.textContent = r.name;
        arSelect.appendChild(opt);
    });
    arSelect.value = "0";
    const wInput = document.createElement("input");
    wInput.type = "text";
    wInput.className = "zyf-crop-dim";
    wInput.value = "";
    wInput.title = "裁剪宽度(像素)";
    const xSep = document.createElement("span");
    xSep.className = "zyf-crop-x";
    xSep.textContent = "\u00d7";
    const hInput = document.createElement("input");
    hInput.type = "text";
    hInput.className = "zyf-crop-dim";
    hInput.value = "";
    hInput.title = "裁剪高度(像素)";
    toolbar.appendChild(arSelect);
    toolbar.appendChild(wInput);
    toolbar.appendChild(xSep);
    toolbar.appendChild(hInput);
    parentEl.appendChild(toolbar);

    // ---- Crop box overlay ------------------------------------------------
    const box = document.createElement("div");
    box.className = "zyf-crop-overlay";
    box.style.display = "none";
    parentEl.appendChild(box);
    // 3x3 gridlines
    for (let i = 1; i <= 2; i++) {
        const v = document.createElement("div");
        v.className = "zyf-crop-gridline zyf-crop-gridline-v";
        v.style.left = `${(i * 100) / 3}%`;
        box.appendChild(v);
        const h = document.createElement("div");
        h.className = "zyf-crop-gridline zyf-crop-gridline-h";
        h.style.top = `${(i * 100) / 3}%`;
        box.appendChild(h);
    }
    // 8 resize handles
    const HANDLE_BORDER_COLOR = "#0284c7";
    const HANDLE_BORDER_WIDTH = "6px";
    const HANDLE_POSITIONS = [
        { name: "tl", cursor: "nwse-resize", pos: { top: "-6px", left: "-6px" }, borders: ["top", "left"] },
        { name: "tr", cursor: "nesw-resize", pos: { top: "-6px", right: "-6px" }, borders: ["top", "right"] },
        { name: "bl", cursor: "nesw-resize", pos: { bottom: "-6px", left: "-6px" }, borders: ["bottom", "left"] },
        { name: "br", cursor: "nwse-resize", pos: { bottom: "-6px", right: "-6px" }, borders: ["bottom", "right"] },
        { name: "tm", cursor: "ns-resize", pos: { top: "-6px", left: "50%" }, transform: "translateX(-50%)", borders: ["top"] },
        { name: "bm", cursor: "ns-resize", pos: { bottom: "-6px", left: "50%" }, transform: "translateX(-50%)", borders: ["bottom"] },
        { name: "lm", cursor: "ew-resize", pos: { top: "50%", left: "-6px" }, transform: "translateY(-50%)", borders: ["left"] },
        { name: "rm", cursor: "ew-resize", pos: { top: "50%", right: "-6px" }, transform: "translateY(-50%)", borders: ["right"] },
    ];
    const CORNER_HANDLES = new Set(["tl", "tr", "bl", "br"]);
    const EDGE_HANDLES = new Set(["tm", "bm", "lm", "rm"]);
    const handles = {};
    for (const def of HANDLE_POSITIONS) {
        const h = document.createElement("div");
        h.className = "zyf-crop-handle";
        if (EDGE_HANDLES.has(def.name)) h.classList.add("zyf-crop-handle-edge");
        h.dataset.handle = def.name;
        h.style.cursor = def.cursor;
        Object.assign(h.style, def.pos);
        if (def.transform) h.style.transform = def.transform;
        def.borders.forEach((b) => {
            h.style[`border${b.charAt(0).toUpperCase() + b.slice(1)}`] = `${HANDLE_BORDER_WIDTH} solid ${HANDLE_BORDER_COLOR}`;
        });
        if (CORNER_HANDLES.has(def.name)) {
            const fillSize = "8px";
            const fillOffset = "0px";
            let shadow = "none";
            if (def.name === "tl") shadow = `inset ${fillOffset} ${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "tr") shadow = `inset -${fillOffset} ${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "bl") shadow = `inset ${fillOffset} -${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "br") shadow = `inset -${fillOffset} -${fillOffset} 0 0 ${fillSize} ${HANDLE_BORDER_COLOR}`;
            h.style.boxShadow = shadow;
        } else if (EDGE_HANDLES.has(def.name)) {
            const fillSize = "12px";
            let shadow = "none";
            if (def.name === "tm") shadow = `inset 0 -${fillSize} 0 0 ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "bm") shadow = `inset 0 ${fillSize} 0 0 ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "lm") shadow = `inset -${fillSize} 0 0 0 ${HANDLE_BORDER_COLOR}`;
            else if (def.name === "rm") shadow = `inset ${fillSize} 0 0 0 ${HANDLE_BORDER_COLOR}`;
            h.style.boxShadow = shadow;
        }
        box.appendChild(h);
        handles[def.name] = h;
    }

    // ---- Internal state --------------------------------------------------
    let isVisible = false;
    let currentAspectRatio = 0;
    let dragHandle = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartCx = 0;
    let dragStartCy = 0;
    let dragStartCw = 1;
    let dragStartCh = 1;

    // 2026-07-21: 支持外部覆盖（保存视频的 object-fit: fill 模式下，
    // 视频拉伸铺满整个容器，没有黑边；默认的 contain 假设会让裁剪
    // 框只覆盖视频实际像素区域而不是预览容器）
    const getRenderedVideoRect = params.getRenderedVideoRect || (() => {
        if (!videoEl) return null;
        const vw = videoEl.videoWidth || 0;
        const vh = videoEl.videoHeight || 0;
        if (!vw || !vh) return null;
        const cw = videoEl.clientWidth;
        const ch = videoEl.clientHeight;
        if (cw <= 0 || ch <= 0) return null;
        const ratio = Math.min(cw / vw, ch / vh);
        return {
            x: (cw - vw * ratio) / 2,
            y: (ch - vh * ratio) / 2,
            w: vw * ratio,
            h: vh * ratio,
        };
    });

    const readState = () => {
        const s = getCropState();
        let cx = _clampCropFraction(s.cx ?? 0);
        let cy = _clampCropFraction(s.cy ?? 0);
        let cw = Math.max(_CROP_MIN_FRACTION, Math.min(1, _clampCropFraction(s.cw ?? 1)));
        let ch = Math.max(_CROP_MIN_FRACTION, Math.min(1, _clampCropFraction(s.ch ?? 1)));
        if (cx + cw > 1) cx = Math.max(0, 1 - cw);
        if (cy + ch > 1) cy = Math.max(0, 1 - ch);
        return { cx, cy, cw, ch };
    };

    const writeState = (cx, cy, cw, ch) => {
        cx = _clampCropFraction(cx);
        cy = _clampCropFraction(cy);
        cw = Math.max(_CROP_MIN_FRACTION, Math.min(1, cw));
        ch = Math.max(_CROP_MIN_FRACTION, Math.min(1, ch));
        if (cx + cw > 1) cx = 1 - cw;
        if (cy + ch > 1) cy = 1 - ch;
        if (cx < 0) cx = 0;
        if (cy < 0) cy = 0;
        setCropState(cx, cy, cw, ch);
    };

    const render = () => {
        const { cx, cy, cw, ch } = readState();
        const rect = getRenderedVideoRect();
        if (rect && rect.w > 0 && rect.h > 0) {
            box.style.left = `${Math.round(rect.x + cx * rect.w)}px`;
            box.style.top = `${Math.round(rect.y + cy * rect.h)}px`;
            box.style.width = `${Math.round(cw * rect.w)}px`;
            box.style.height = `${Math.round(ch * rect.h)}px`;
        }
        const { w: outW, h: outH } = getOutputPixelSize();
        if (outW > 0 && outH > 0) {
            if (document.activeElement !== wInput) wInput.value = String(Math.round(cw * outW));
            if (document.activeElement !== hInput) hInput.value = String(Math.round(ch * outH));
        }
        const isFull = (cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);
        if (isFull || isVisible) {
            cropDimsLabel.style.display = "none";
        } else if (outW > 0 && outH > 0) {
            cropDimsLabel.textContent = `${Math.max(1, Math.round(cw * outW))}\u00d7${Math.max(1, Math.round(ch * outH))}`;
            cropDimsLabel.style.display = "inline-flex";
        }
        if (!isVisible) {
            const showPreview = !isFull;
            box.classList.toggle("zyf-crop-overlay--preview", showPreview);
            box.style.display = showPreview ? "block" : "none";
        }
    };

    const setVisible = (visible) => {
        isVisible = !!visible;
        const { cx, cy, cw, ch } = readState();
        const hasCrop = !(cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);
        const showPreview = !isVisible && hasCrop;
        box.classList.toggle("zyf-crop-overlay--preview", showPreview);
        box.style.display = (isVisible || showPreview) ? "block" : "none";
        toolbar.style.display = isVisible ? "flex" : "none";
        resetBtn.style.display = isVisible ? "inline-flex" : "none";
        toggle.classList.toggle("active", isVisible);
        // 2026-07-21: 通知外部裁剪编辑器可见性变化，便于保存视频等
        // 节点同步屏蔽音频控件、播放 overlay 等。
        if (typeof params.onVisibilityChange === "function") {
            try { params.onVisibilityChange(isVisible); } catch (err) {}
        }
        if (isVisible) {
            try { videoEl?.pause?.(); } catch (err) {}
            box.style.zIndex = "150";
            toolbar.style.zIndex = "151";
            toggle.style.zIndex = "151";
            resetBtn.style.zIndex = "151";
            render();
        } else {
            dragHandle = null;
            box.style.zIndex = "50";
            toolbar.style.zIndex = "110";
            toggle.style.zIndex = "110";
            resetBtn.style.zIndex = "110";
            render();
        }
    };

    // ---- Aspect ratio ----------------------------------------------------
    const applyAspectRatio = (newRatio) => {
        const { cx, cy, cw, ch } = readState();
        const vw = videoEl?.videoWidth || 16;
        const vh = videoEl?.videoHeight || 9;
        let ratio = newRatio;
        if (ratio === -1 && vw && vh) ratio = vw / vh;
        currentAspectRatio = (ratio > 0) ? ratio : 0;
        if (currentAspectRatio > 0) {
            const centerX = cx + cw / 2;
            const centerY = cy + ch / 2;
            const R = currentAspectRatio * (vh / vw);
            let newCw = cw;
            let newCh = ch;
            if (R > 0) {
                if (R * ch >= cw) { newCh = Math.min(1, ch || 1); newCw = newCh * R; }
                else { newCw = Math.min(1, cw || 1); newCh = newCw / R; }
                if (newCw > 1) newCw = 1;
                if (newCh > 1) newCh = 1;
            }
            let newCx = centerX - newCw / 2;
            let newCy = centerY - newCh / 2;
            if (newCx < 0) newCx = 0;
            if (newCy < 0) newCy = 0;
            if (newCx + newCw > 1) newCx = 1 - newCw;
            if (newCy + newCh > 1) newCy = 1 - newCh;
            writeState(newCx, newCy, newCw, newCh);
        }
        render();
    };
    arSelect.addEventListener("change", () => applyAspectRatio(Number(arSelect.value)));

    // ---- Manual W/H input ------------------------------------------------
    const applyManualDimension = (isWidth) => {
        const { cx, cy, cw, ch } = readState();
        const { w: outW, h: outH } = getOutputPixelSize();
        if (outW <= 0 || outH <= 0) return;
        const newW = Math.max(1, Math.min(parseInt(wInput.value, 10) || Math.round(cw * outW), outW));
        const newH = Math.max(1, Math.min(parseInt(hInput.value, 10) || Math.round(ch * outH), outH));
        let targetW, targetH;
        if (currentAspectRatio > 0) {
            if (isWidth) { targetW = newW; targetH = Math.round(targetW / currentAspectRatio); }
            else { targetH = newH; targetW = Math.round(targetH * currentAspectRatio); }
            if (targetH > outH) { targetH = outH; targetW = Math.round(targetH * currentAspectRatio); }
            if (targetW > outW) { targetW = outW; targetH = Math.round(targetW / currentAspectRatio); }
        } else { targetW = newW; targetH = newH; }
        targetW = Math.max(1, Math.min(targetW, outW));
        targetH = Math.max(1, Math.min(targetH, outH));
        let nw = targetW / outW;
        let nh = targetH / outH;
        let nx = cx; let ny = cy;
        if (nx + nw > 1) nx = 1 - nw;
        if (ny + nh > 1) ny = 1 - nh;
        if (nx < 0) nx = 0; if (ny < 0) ny = 0;
        writeState(nx, ny, nw, nh);
        render();
    };
    wInput.addEventListener("change", () => applyManualDimension(true));
    hInput.addEventListener("change", () => applyManualDimension(false));
    wInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyManualDimension(true); });
    hInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyManualDimension(false); });

    // ---- Pointer drag ----------------------------------------------------
    const onPointerMove = (e) => {
        if (!dragHandle) return;
        e.preventDefault();
        const rect = getRenderedVideoRect();
        if (!rect || !rect.w || !rect.h) return;
        const dx = (e.clientX - dragStartX) / rect.w;
        const dy = (e.clientY - dragStartY) / rect.h;
        let newCx = dragStartCx, newCy = dragStartCy, newCw = dragStartCw, newCh = dragStartCh;
        if (dragHandle === "center") { newCx = dragStartCx + dx; newCy = dragStartCy + dy; }
        else if (dragHandle === "tl") { newCx = dragStartCx + dx; newCy = dragStartCy + dy; newCw = dragStartCw - dx; newCh = dragStartCh - dy; }
        else if (dragHandle === "tr") { newCy = dragStartCy + dy; newCw = dragStartCw + dx; newCh = dragStartCh - dy; }
        else if (dragHandle === "bl") { newCx = dragStartCx + dx; newCw = dragStartCw - dx; newCh = dragStartCh + dy; }
        else if (dragHandle === "br") { newCw = dragStartCw + dx; newCh = dragStartCh + dy; }
        else if (dragHandle === "tm") { newCy = dragStartCy + dy; newCh = dragStartCh - dy; }
        else if (dragHandle === "bm") { newCh = dragStartCh + dy; }
        else if (dragHandle === "lm") { newCx = dragStartCx + dx; newCw = dragStartCw - dx; }
        else if (dragHandle === "rm") { newCw = dragStartCw + dx; }
        if (currentAspectRatio > 0) {
            const vw = videoEl?.videoWidth || rect.w || 1;
            const vh = videoEl?.videoHeight || rect.h || 1;
            const R = currentAspectRatio * (vh / vw);
            if (dragHandle === "tm" || dragHandle === "bm") { newCw = newCh * R; newCx = dragStartCx + (dragStartCw - newCw) / 2; }
            else if (dragHandle === "lm" || dragHandle === "rm") { newCh = newCw / R; newCy = dragStartCy + (dragStartCh - newCh) / 2; }
            else { newCh = newCw / R; }
        }
        if (newCw < _CROP_MIN_FRACTION) newCw = _CROP_MIN_FRACTION;
        if (newCh < _CROP_MIN_FRACTION) newCh = _CROP_MIN_FRACTION;
        if (newCx < 0) newCx = 0;
        if (newCy < 0) newCy = 0;
        if (newCx + newCw > 1) { if (dragHandle === "center") newCx = 1 - newCw; else newCw = 1 - newCx; }
        if (newCy + newCh > 1) { if (dragHandle === "center") newCy = 1 - newCh; else newCh = 1 - newCy; }
        newCx = Math.max(0, Math.min(newCx, 1 - newCw));
        newCy = Math.max(0, Math.min(newCy, 1 - newCh));
        newCw = Math.max(_CROP_MIN_FRACTION, Math.min(newCw, 1 - newCx));
        newCh = Math.max(_CROP_MIN_FRACTION, Math.min(newCh, 1 - newCy));
        writeState(newCx, newCy, newCw, newCh);
        render();
    };
    const onPointerUp = () => {
        if (!dragHandle) return;
        dragHandle = null;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
    };
    const startDrag = (e, handle) => {
        if (!isVisible) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = getRenderedVideoRect();
        if (!rect || !rect.w || !rect.h) return;
        dragHandle = handle;
        const { cx, cy, cw, ch } = readState();
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartCx = cx;
        dragStartCy = cy;
        dragStartCw = cw;
        dragStartCh = ch;
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp, { passive: false });
    };
    box.addEventListener("pointerdown", (e) => {
        if (!isVisible) return;
        const isHandle = e.target.classList?.contains("zyf-crop-handle");
        if (isHandle) return;
        startDrag(e, "center");
    });
    for (const name of Object.keys(handles)) {
        handles[name].addEventListener("pointerdown", (e) => startDrag(e, name));
    }

    // ---- Toggle / reset --------------------------------------------------
    toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setVisible(!isVisible);
    });
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        toggle.addEventListener(ev, (e) => e.stopPropagation());
    });
    [toggle, toolbar].forEach((el) => {
        ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
            el.addEventListener(ev, (e) => e.stopPropagation());
        });
    });
    resetBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        writeState(0, 0, 1, 1);
        currentAspectRatio = 0;
        arSelect.value = "0";
        render();
    });
    ["mousedown", "mouseup", "dblclick", "wheel", "contextmenu"].forEach((ev) => {
        resetBtn.addEventListener(ev, (e) => e.stopPropagation());
    });

    // ---- Attach video metadata listeners ---------------------------------
    let loadedMetadataBound = false;
    const onLoadedMetadata = () => { if (isVisible) render(); };
    const attachVideoListeners = () => {
        if (!videoEl || loadedMetadataBound) return;
        videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
        videoEl.addEventListener("seeked", onLoadedMetadata);
        loadedMetadataBound = true;
    };
    attachVideoListeners();

    // ---- Public API ------------------------------------------------------
    const refresh = () => {
        attachVideoListeners();
        render();
    };
    const isCropVisible = () => isVisible;
    const getCropForScreenshot = () => {
        const { cx, cy, cw, ch } = readState();
        const isFull = (cx <= 0.0 && cy <= 0.0 && cw >= 0.999 && ch >= 0.999);
        return isFull ? null : { cx, cy, cw, ch };
    };

    return { toggle, box, refresh, setVisible, isVisible: isCropVisible, getCropForScreenshot };
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
