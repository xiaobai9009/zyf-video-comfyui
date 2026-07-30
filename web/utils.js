'use strict';

import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

export async function processVideoEntry(path) {
    const body = {
        path: path,
    };
    const result = await api.fetchApi("/process_video_entry", { method: "POST", body: JSON.stringify(body) });
    if (result.error) {
        console.error(`processVideoEntry error: ${result.error}`);
        return undefined;
    }
    const jsonData = await result.json();
    const frameDuration = jsonData.duration / jsonData.total_frames;
    jsonData.frame_duration = frameDuration;
    return jsonData;
}

/*
Attribution: ComfyUI-Custom-Scripts

Portions of this code are adapted from GitHub repository `https://github.com/pythongosssss/ComfyUI-Custom-Scripts`,
which is licensed under the MIT License:
*/
export function zyfAddStylesheet(url) {
    $el("link", {
        parent: document.head,
        rel: "stylesheet",
        type: "text/css",
        href: url.startsWith("http") ? url : zyfGetUrl(url),
    });
}

/*
Attribution: ComfyUI-Custom-Scripts

Portions of this code are adapted from GitHub repository `https://github.com/pythongosssss/ComfyUI-Custom-Scripts`,
which is licensed under the MIT License:
*/
export function zyfGetUrl(path, baseUrl) {
    if (baseUrl) {
        return new URL(path, baseUrl).toString();
    }
    else {
        return new URL("../" + path, import.meta.url).toString();
    }
}

/*
Attribution: ComfyUI-VideoHelperSuite

Portions of this code are adapted from GitHub repository `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite`,
which is licensed under the GNU General Public License version 3 (GPL-3.0):
*/
export async function zyfUploadFile(file) {
    //TODO: Add uploaded file to cache with Cache.put()?
    try {
        // Wrap file in formdata so it includes filename
        const body = new FormData();
        const i = file.webkitRelativePath.lastIndexOf('/');
        const subfolder = file.webkitRelativePath.slice(0,i+1)
        const new_file = new File([file], file.name, {
            type: file.type,
            lastModified: file.lastModified,
        });
        body.append("image", new_file);
        if (i > 0) {
            body.append("subfolder", subfolder);
        }
        const resp = await api.fetchApi("/upload/image", {
            method: "POST",
            body,
        });

        if (resp.status === 200) {
            return resp.status
        } else {
            alert(resp.status + " - " + resp.statusText);
        }
    } catch (error) {
        alert(error);
    }
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

/**
 * Apply tooltips to every widget on a node. The tooltip text is taken
 * from the widget's options dict (set on the Python side via the
 * ``tooltip`` key in INPUT_TYPES) OR from the provided fallback map.
 *
 * ComfyUI's frontend reads ``widget.options.tooltip`` when it creates a
 * widget and stores it on ``widget.tooltip``, but older / stripped-down
 * frontends may not. To make the tooltips visible across all ComfyUI
 * builds we also stamp the text as a native HTML ``title`` attribute
 * on the widget's input / element node — that way the browser shows
 * the tooltip even if the custom in-graph tooltip layer is missing.
 *
 * @param {Object} node                LiteGraph node instance.
 * @param {Object} [fallbackTooltips]  Optional { widgetName: tooltipText } map
 *                                     used when a widget has no tooltip yet.
 */
export function applyZyfTooltips(node, fallbackTooltips) {
    if (!node || !Array.isArray(node.widgets)) {
        return;
    }
    for (const widget of node.widgets) {
        if (!widget) {
            continue;
        }
        const name = widget.name;
        const text =
            (widget.options && widget.options.tooltip)
            || (fallbackTooltips && fallbackTooltips[name])
            || widget.tooltip
            || "";
        if (!text) {
            continue;
        }
        // ComfyUI's frontend reads this and renders a custom tooltip
        // in-graph; setting it is cheap and idempotent.
        widget.tooltip = text;
        // Native HTML title fallback for frontends that don't render
        // widget.tooltip. We stamp every plausible DOM target so the
        // tooltip works regardless of which element LiteGraph uses
        // for the widget's input.
        const targets = [
            widget.inputEl,
            widget.element,
            widget.options?.element,
            widget.el,
        ];
        for (const el of targets) {
            if (el && el.setAttribute) {
                el.setAttribute("title", text);
            }
        }
    }
}
