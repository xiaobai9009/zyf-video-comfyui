// 裁剪修复补丁 v2 - 在浏览器控制台直接运行
// 这个脚本会直接修复已加载的代码，绕过缓存问题

console.log('[zyf-video Crop Fix v2] 开始修复...');

// 等待节点加载
function waitForNode() {
    const node = app.graph._nodes.find(n => n.type === "zyf加载视频");
    if (!node || !node.previewWidget || !node.previewWidget.cropOverlay) {
        console.log('[zyf-video Crop Fix v2] 等待节点加载...');
        setTimeout(waitForNode, 1000);
        return;
    }
    
    console.log('[zyf-video Crop Fix v2] 找到节点，应用修复...');
    applyFix(node);
}

function applyFix(node) {
    const pw = node.previewWidget;
    const overlay = pw.cropOverlay;
    
    // 保存原始的syncFromWidgets
    const originalSync = overlay.syncFromWidgets;
    
    // 创建修复版本的getRenderedVideoRect
    const getRenderedVideoRectFixed = function() {
        const videoEl = pw.videoEl;
        if (!videoEl) {
            console.log('[Fix] 没有videoEl');
            return null;
        }
        
        const vw = videoEl.videoWidth || 0;
        const vh = videoEl.videoHeight || 0;
        if (!vw || !vh) {
            console.log('[Fix] 没有视频尺寸');
            return null;
        }
        
        const vRect = videoEl.getBoundingClientRect();
        const elemWidth = vRect.width;
        const elemHeight = vRect.height;
        
        if (elemWidth <= 0 || elemHeight <= 0) {
            console.log('[Fix] 元素尺寸无效');
            return null;
        }
        
        const videoAspect = vw / vh;
        const elemAspect = elemWidth / elemHeight;
        
        let renderedW, renderedH, xOffset, yOffset;
        
        if (videoAspect > elemAspect) {
            // 视频更宽
            renderedW = elemWidth;
            renderedH = elemWidth / videoAspect;
            xOffset = 0;
            yOffset = (elemHeight - renderedH) / 2;
        } else {
            // 视频更高
            renderedH = elemHeight;
            renderedW = elemHeight * videoAspect;
            xOffset = (elemWidth - renderedW) / 2;
            yOffset = 0;
        }
        
        console.log('[Fix] 计算结果:', {
            video: `${vw}x${vh}`,
            element: `${elemWidth.toFixed(1)}x${elemHeight.toFixed(1)}`,
            rendered: `${renderedW.toFixed(1)}x${renderedH.toFixed(1)}`,
            offset: `${xOffset.toFixed(1)},${yOffset.toFixed(1)}`
        });
        
        return {
            x: xOffset,
            y: yOffset,
            w: renderedW,
            h: renderedH
        };
    };
    
    // 替换syncFromWidgets函数，使用修复的getRenderedVideoRect
    overlay.syncFromWidgets = function() {
        const rect = getRenderedVideoRectFixed();
        if (!rect) {
            console.log('[Fix] 无法获取渲染区域');
            return;
        }
        
        // 获取裁剪值
        const cx = node.cropXWidget?.value || 0;
        const cy = node.cropYWidget?.value || 0;
        const cw = node.cropWWidget?.value || 1;
        const ch = node.cropHWidget?.value || 1;
        
        // 查找裁剪框元素
        const box = pw.parentEl.querySelector('.zyf-crop-overlay');
        if (!box) {
            console.log('[Fix] 找不到裁剪框元素');
            return;
        }
        
        // 计算位置
        const boxLeft = rect.x + cx * rect.w;
        const boxTop = rect.y + cy * rect.h;
        const boxWidth = cw * rect.w;
        const boxHeight = ch * rect.h;
        
        console.log('[Fix] 设置裁剪框:', {
            left: boxLeft.toFixed(1),
            top: boxTop.toFixed(1),
            width: boxWidth.toFixed(1),
            height: boxHeight.toFixed(1)
        });
        
        box.style.left = `${Math.round(boxLeft)}px`;
        box.style.top = `${Math.round(boxTop)}px`;
        box.style.width = `${Math.round(boxWidth)}px`;
        box.style.height = `${Math.round(boxHeight)}px`;
    };
    
    overlay.refresh = overlay.syncFromWidgets;
    
    // 立即刷新一次
    overlay.syncFromWidgets();
    
    console.log('[zyf-video Crop Fix v2] 修复完成！现在可以正常使用裁剪功能了');
    console.log('[zyf-video Crop Fix v2] 点击"裁剪"按钮来测试');
}

// 开始等待
waitForNode();
