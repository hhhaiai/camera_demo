class HandGestureDrawing {
    constructor() {
        this.video = document.getElementById('video');
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.status = document.getElementById('status');
        this.debugInfo = document.getElementById('debugInfo');
        this.drawingInfo = document.getElementById('drawingInfo');

        // 提高分辨率
        this.canvas.width = 960;
        this.canvas.height = 720;

        // 创建骨架渲染层
        this.skeletonCanvas = document.createElement('canvas');
        this.skeletonCtx = this.skeletonCanvas.getContext('2d');
        this.skeletonCanvas.width = 960;
        this.skeletonCanvas.height = 720;
        this.skeletonCanvas.style.position = 'absolute';
        this.skeletonCanvas.style.top = '0';
        this.skeletonCanvas.style.left = '0';
        this.skeletonCanvas.style.pointerEvents = 'none';

        // 将骨架canvas添加到视频容器中
        const videoContainer = document.querySelector('.video-container');
        videoContainer.appendChild(this.skeletonCanvas);

        this.isDrawing = false;
        this.lastPoint = null;
        this.previousPoint = null;
        this.lastDrawTime = 0;
        this.currentColor = '#ff0000';
        this.lineWidth = 8;

        // 创建绘画缓存canvas
        this.drawingCache = document.createElement('canvas');
        this.drawingCacheCtx = this.drawingCache.getContext('2d');
        this.drawingCache.width = 960;
        this.drawingCache.height = 720;

        this.hands = null;
        this.camera = null;
        this.frameCount = 0;

        // 性能优化参数
        this.lastProcessTime = 0;
        this.processInterval = 100; // 每100ms处理一次，提高性能
        this.gestureStabilityBuffer = [];
        this.gestureBufferSize = 3;
        this.lastGestureTime = 0;
        this.gestureDebounceTime = 50;

        // 性能监控
        this.lastFrameTime = 0;
        this.fps = 0;

        this.initializeEventListeners();
        this.setupCanvas();
        this.runDiagnostics();
    }

    runDiagnostics() {
        let diagnostics = [];

        // 检查浏览器信息
        diagnostics.push(`浏览器: ${navigator.userAgent.split(' ').slice(-2).join(' ')}`);
        diagnostics.push(`协议: ${location.protocol}`);
        diagnostics.push(`主机: ${location.hostname}`);

        // 检查API支持
        diagnostics.push(`getUserMedia: ${navigator.mediaDevices ? '支持' : '不支持'}`);
        diagnostics.push(`Canvas: ${this.canvas ? '支持' : '不支持'}`);
        diagnostics.push(`MediaPipe Hands: ${typeof Hands !== 'undefined' ? '已加载' : '未加载'}`);
        diagnostics.push(`MediaPipe Camera: ${typeof Camera !== 'undefined' ? '已加载' : '未加载'}`);

        this.updateDebug(`系统诊断:<br>${diagnostics.join('<br>')}`);
    }

    initializeEventListeners() {
        document.getElementById('startBtn').addEventListener('click', () => this.startCamera());
        document.getElementById('retryBtn').addEventListener('click', () => this.retryStart());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearCanvas());
        document.getElementById('saveBtn').addEventListener('click', () => this.saveImage());

        // 颜色选择
        document.querySelectorAll('.color-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
                e.target.classList.add('selected');
                this.currentColor = e.target.dataset.color;
            });
        });
    }

    retryStart() {
        // 重置状态
        this.hands = null;
        this.camera = null;
        this.frameCount = 0;
        this.gestureStabilityBuffer = [];

        // 隐藏重试按钮，显示启动按钮
        document.getElementById('retryBtn').style.display = 'none';
        document.getElementById('startBtn').style.display = 'inline-block';
        document.getElementById('startBtn').disabled = false;

        // 重新启动
        this.startCamera();
    }

    setupCanvas() {
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.lineWidth = this.lineWidth;
        this.ctx.strokeStyle = this.currentColor;
    }

    async startCamera() {
        try {
            this.updateStatus('正在启动摄像头...', 'ready');
            this.updateDebug('开始初始化摄像头...');

            if (!this.checkBrowserSupport()) {
                throw new Error('浏览器不支持所需功能');
            }

            const stream = await this.getUserMedia({
                video: {
                    width: 960,
                    height: 720,
                    facingMode: 'user'
                }
            });

            this.video.srcObject = stream;
            this.updateDebug('摄像头流已设置');

            await new Promise((resolve, reject) => {
                this.video.onloadedmetadata = resolve;
                this.video.onerror = reject;
                setTimeout(() => reject(new Error('视频加载超时')), 10000);
            });

            this.updateDebug('正在初始化MediaPipe Hands...');

            if (typeof Hands === 'undefined') {
                throw new Error('MediaPipe Hands库未加载，请检查网络连接');
            }

            try {
                this.hands = new Hands({
                    locateFile: (file) => {
                        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`;
                    }
                });

                this.hands.setOptions({
                    maxNumHands: 1, // 只检测一只手，提高性能
                    modelComplexity: 0, // 降低模型复杂度，提高速度
                    minDetectionConfidence: 0.7,
                    minTrackingConfidence: 0.5
                });

                this.hands.onResults((results) => this.onResults(results));
                this.updateDebug('MediaPipe Hands 已初始化');
            } catch (mpError) {
                throw new Error(`MediaPipe初始化失败: ${mpError.message}`);
            }

            if (typeof Camera === 'undefined') {
                throw new Error('MediaPipe Camera库未加载，请检查网络连接');
            }

            // 优化摄像头处理频率
            this.camera = new Camera(this.video, {
                onFrame: async () => {
                    this.frameCount++;

                    // 性能监控
                    const currentTime = performance.now();
                    if (this.lastFrameTime > 0) {
                        const deltaTime = currentTime - this.lastFrameTime;
                        this.fps = Math.round(1000 / deltaTime);
                    }
                    this.lastFrameTime = currentTime;

                    // 限制处理频率，提高性能
                    if (currentTime - this.lastProcessTime > this.processInterval) {
                        try {
                            await this.hands.send({ image: this.video });
                            this.lastProcessTime = currentTime;
                        } catch (error) {
                            console.warn('手势识别处理错误:', error);
                        }
                    }

                    // 减少调试信息更新频率
                    if (this.frameCount % 120 === 0) {
                        this.updateDebug(`处理帧数: ${this.frameCount} | FPS: ${this.fps} | 处理间隔: ${this.processInterval}ms`);
                    }
                },
                width: 960,
                height: 720
            });

            await this.camera.start();

            this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
            this.updateDrawingStatus('🚀 <strong>摄像头已启动！</strong><br>👋 伸出手掌显示骨架<br>👆 拇指+食指捏合开始绘画', 'success');
            this.updateDebug('摄像头启动成功，等待手势检测...');
            document.getElementById('startBtn').disabled = true;

        } catch (error) {
            console.error('启动摄像头失败:', error);
            const errorMessage = this.getErrorMessage(error);
            this.updateStatus(errorMessage, 'error');
            this.updateDebug(`错误详情: ${error.message}`);

            document.getElementById('startBtn').style.display = 'none';
            document.getElementById('retryBtn').style.display = 'inline-block';
        }
    }

    checkBrowserSupport() {
        // 检查基本的浏览器支持
        if (!navigator) {
            this.updateDebug('错误: navigator对象不可用');
            return false;
        }

        // 检查getUserMedia支持
        if (!navigator.mediaDevices && !navigator.getUserMedia && !navigator.webkitGetUserMedia && !navigator.mozGetUserMedia) {
            this.updateDebug('错误: 浏览器不支持摄像头访问API');
            return false;
        }

        // 检查Canvas支持
        if (!this.canvas || !this.canvas.getContext) {
            this.updateDebug('错误: 浏览器不支持Canvas');
            return false;
        }

        // 检查HTTPS或localhost
        const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (!isSecure) {
            this.updateDebug('警告: 建议使用HTTPS或localhost访问以获得最佳兼容性');
        }

        return true;
    }

    async getUserMedia(constraints) {
        // 现代浏览器
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            return await navigator.mediaDevices.getUserMedia(constraints);
        }

        // 兼容旧版浏览器
        const getUserMedia = navigator.getUserMedia ||
            navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia ||
            navigator.msGetUserMedia;

        if (!getUserMedia) {
            throw new Error('浏览器不支持摄像头访问');
        }

        return new Promise((resolve, reject) => {
            getUserMedia.call(navigator, constraints, resolve, reject);
        });
    }

    getErrorMessage(error) {
        switch (error.name) {
            case 'NotAllowedError':
                return '摄像头权限被拒绝，请在浏览器设置中允许摄像头访问';
            case 'NotFoundError':
                return '未找到摄像头设备，请检查设备连接';
            case 'NotReadableError':
                return '摄像头被其他应用占用，请关闭其他应用后重试';
            case 'OverconstrainedError':
                return '摄像头不支持请求的分辨率，请尝试其他设备';
            default:
                if (error.message.includes('MediaPipe')) {
                    return 'AI模型加载失败，请检查网络连接并刷新页面';
                }
                if (error.message.includes('浏览器不支持')) {
                    return '浏览器版本过旧或不支持所需功能，请使用Chrome、Firefox或Safari最新版本';
                }
                return `摄像头启动失败: ${error.message}`;
        }
    }

    onResults(results) {
        try {
            // 1. 绘制视频背景（镜像翻转，左手显示在左侧）
            this.ctx.save();
            this.ctx.scale(-1, 1);
            this.ctx.drawImage(this.video, -this.canvas.width, 0, this.canvas.width, this.canvas.height);
            this.ctx.restore();

            // 2. 叠加绘画缓存（也需要镜像翻转）
            this.ctx.save();
            this.ctx.scale(-1, 1);
            this.ctx.drawImage(this.drawingCache, -this.canvas.width, 0);
            this.ctx.restore();

            // 3. 清除骨架canvas
            this.clearHandSkeleton();

            // 4. 绘制手部骨架
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                this.drawHandSkeletons(results);
            }

            // 处理手势识别
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks = results.multiHandLandmarks[0];
                const handedness = results.multiHandedness ? results.multiHandedness[0].label : 'Unknown';

                // 检测停止手势
                const stopGestureDetected = this.detectStopGesture(landmarks);
                if (stopGestureDetected && this.isDrawing) {
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.updateStatus('检测到停止手势，已停止绘画', 'ready');
                    this.updateDebug('检测到停止手势：食指指向掌心');
                    return;
                }

                // 获取关键点
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];

                // 绘画点坐标（镜像翻转，与视频显示保持一致）
                const drawPoint = {
                    x: (1 - indexTip.x) * this.canvas.width,
                    y: indexTip.y * this.canvas.height
                };

                // 手势分析
                const gestureData = this.analyzePinchGesture(landmarks);
                const stableGesture = this.stabilizeGesture(gestureData.isPinching);

                // 调试信息
                this.updateDebug(`
                    检测到${handedness}手 | FPS: ${this.fps} |
                    手掌朝向: ${gestureData.palmFacing ? '面向摄像头' : '侧向/背向'} |
                    捏合状态: ${gestureData.isPinching ? '是' : '否'} |
                    稳定手势: ${stableGesture ? '是' : '否'} |
                    绘画状态: ${this.isDrawing ? '绘画中' : '未绘画'} |
                    食指位置: (${drawPoint.x.toFixed(0)}, ${drawPoint.y.toFixed(0)})
                `);

                // 防抖处理
                const currentTime = Date.now();
                if (currentTime - this.lastGestureTime < this.gestureDebounceTime) {
                    return;
                }

                // 新的绘画逻辑：
                // 1. 如果未在绘画模式，检测捏合手势开始绘画
                if (!this.isDrawing) {
                    if (stableGesture && gestureData.palmFacing) {
                        this.isDrawing = true;
                        this.lastPoint = drawPoint;
                        this.previousPoint = null;
                        this.lastDrawTime = 0;
                        this.updateStatus('绘画模式已激活，松开手指，用食指移动绘画', 'drawing');
                        this.updateDrawingStatus('🎨 <strong>绘画模式已激活！</strong><br>✅ 松开手指，用食指移动进行绘画<br>🛑 食指指向掌心停止绘画', 'success');
                        this.lastGestureTime = currentTime;
                        this.updateDebug('🎨 捏合检测成功，开始绘画模式！');
                    } else if (gestureData.palmFacing) {
                        // 手掌面向摄像头但未捏合，显示提示
                        this.updateDrawingStatus('👆 <strong>准备绘画</strong><br>📌 拇指+食指捏合开始绘画<br>🤚 保持手掌面向摄像头', 'info');
                    }
                }
                // 2. 如果已在绘画模式，用食指位置继续绘画（不需要保持捏合）
                else if (this.isDrawing && gestureData.palmFacing) {
                    if (this.lastPoint) {
                        // 计算食指移动距离，避免抖动
                        const distance = this.calculateDistance2D(this.lastPoint, drawPoint);
                        if (distance > 3) { // 最小移动距离阈值，减少抖动
                            this.drawLine(this.lastPoint, drawPoint);
                            this.lastPoint = drawPoint;
                            this.updateDrawingStatus('✏️ <strong>绘画中...</strong><br>🎯 食指位置: (' + drawPoint.x.toFixed(0) + ', ' + drawPoint.y.toFixed(0) + ')<br>🛑 食指指向掌心停止', 'success');
                        }
                    } else {
                        this.lastPoint = drawPoint;
                    }
                }
                // 3. 手掌不再面向摄像头，停止绘画模式
                else if (this.isDrawing && !gestureData.palmFacing) {
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.previousPoint = null;
                    this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
                    this.updateDrawingStatus('🛑 <strong>绘画已停止</strong><br>❌ 手掌不再面向摄像头<br>👆 重新捏合开始绘画', 'warning');
                    this.lastGestureTime = currentTime;
                    this.updateDebug('🛑 手掌不再面向摄像头，停止绘画');
                }
            } else {
                if (this.frameCount % 120 === 0) {
                    this.updateDebug(`未检测到手部，请伸出手掌显示骨架 | FPS: ${this.fps}`);
                }

                if (this.isDrawing) {
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.previousPoint = null;
                    this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
                }

                this.gestureStabilityBuffer = [];
            }
        } catch (error) {
            console.warn('手势处理错误:', error);
            this.updateDebug(`手势处理错误: ${error.message}`);
        }
    }

    analyzePinchGesture(landmarks) {
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const middleTip = landmarks[12];
        const ringTip = landmarks[16];
        const pinkyTip = landmarks[20];

        // 检测手掌朝向（简化版本）
        const palmFacing = this.isHandFacingCamera(landmarks);

        // 计算拇指和食指尖之间的距离
        const tipDistance = this.calculateDistance(thumbTip, indexTip);

        // 调整阈值，使捏合检测更准确
        const threshold = 0.08; // 降低阈值，使捏合检测更精确

        // 检查是否为捏合手势
        const isPinching = tipDistance < threshold;

        // 检查其他手指状态（简化）
        const otherFingersDown = middleTip.y > landmarks[9].y &&
            ringTip.y > landmarks[13].y &&
            pinkyTip.y > landmarks[17].y;

        // 简化的置信度计算
        let confidence = 0;
        if (isPinching && palmFacing && otherFingersDown) {
            confidence = 0.95; // 提高置信度
        } else if (isPinching && palmFacing) {
            confidence = 0.8;
        } else if (isPinching) {
            confidence = 0.6;
        }

        return {
            isPinching: isPinching,
            tipDistance,
            threshold,
            confidence,
            palmFacing,
            otherFingersDown
        };
    }

    // 检测手掌是否面向摄像头（简化版本）
    isHandFacingCamera(landmarks) {
        // 使用手腕和手指关节的相对位置判断
        const wrist = landmarks[0];
        const indexMCP = landmarks[5];
        const pinkyMCP = landmarks[17];

        // 计算手掌宽度（不受镜像翻转影响）
        const palmWidth = Math.abs(indexMCP.x - pinkyMCP.x);

        // 如果手掌宽度较大，说明手掌面向摄像头
        return palmWidth > 0.15;
    }

    // 检测停止手势（食指指向掌心）
    detectStopGesture(landmarks) {
        if (!landmarks) return false;

        const indexTip = landmarks[8];      // 食指尖
        const indexPIP = landmarks[6];      // 食指近端关节
        const indexMCP = landmarks[5];      // 食指掌指关节
        const middleTip = landmarks[12];    // 中指尖
        const ringTip = landmarks[16];      // 无名指尖
        const pinkyTip = landmarks[20];     // 小指尖
        const palmCenter = this.calculatePalmCenter(landmarks);

        // 检查食指是否伸直（其他手指弯曲）
        const indexExtended = indexTip.y < indexPIP.y && indexPIP.y < indexMCP.y;
        const middleBent = middleTip.y > indexMCP.y;
        const ringBent = ringTip.y > indexMCP.y;
        const pinkyBent = pinkyTip.y > indexMCP.y;

        if (!indexExtended || !middleBent || !ringBent || !pinkyBent) {
            return false;
        }

        // 计算食指指向方向
        const fingerDirection = {
            x: indexTip.x - indexPIP.x,
            y: indexTip.y - indexPIP.y
        };

        // 计算从食指尖到掌心的向量
        const toPalmVector = {
            x: palmCenter.x - indexTip.x,
            y: palmCenter.y - indexTip.y
        };

        // 计算两个向量的点积（判断是否指向掌心）
        const dotProduct = fingerDirection.x * toPalmVector.x + fingerDirection.y * toPalmVector.y;
        const fingerMagnitude = Math.sqrt(fingerDirection.x ** 2 + fingerDirection.y ** 2);
        const palmMagnitude = Math.sqrt(toPalmVector.x ** 2 + toPalmVector.y ** 2);

        if (fingerMagnitude === 0 || palmMagnitude === 0) return false;

        const cosAngle = dotProduct / (fingerMagnitude * palmMagnitude);

        // 如果夹角小于60度（cos > 0.5），认为是指向掌心
        return cosAngle > 0.5;
    }



    // 计算手掌中心点
    calculatePalmCenter(landmarks) {
        // 使用手掌关键点计算中心
        const wrist = landmarks[0];
        const indexMCP = landmarks[5];
        const middleMCP = landmarks[9];
        const ringMCP = landmarks[13];
        const pinkyMCP = landmarks[17];

        return {
            x: (wrist.x + indexMCP.x + middleMCP.x + ringMCP.x + pinkyMCP.x) / 5,
            y: (wrist.y + indexMCP.y + middleMCP.y + ringMCP.y + pinkyMCP.y) / 5,
            z: (wrist.z + indexMCP.z + middleMCP.z + ringMCP.z + pinkyMCP.z) / 5
        };
    }

    stabilizeGesture(currentGesture) {
        // 简化稳定性检查，直接返回当前手势状态
        this.gestureStabilityBuffer.push(currentGesture);

        // 保持缓冲区大小
        if (this.gestureStabilityBuffer.length > this.gestureBufferSize) {
            this.gestureStabilityBuffer.shift();
        }

        // 如果缓冲区中大部分都是相同手势，返回该手势
        const trueCount = this.gestureStabilityBuffer.filter(g => g).length;
        return trueCount >= Math.ceil(this.gestureBufferSize / 2);
    }

    calculateDistance(point1, point2) {
        const dx = point1.x - point2.x;
        const dy = point1.y - point2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // 计算两个2D点之间的距离（用于Canvas坐标）
    calculateDistance2D(point1, point2) {
        const dx = point1.x - point2.x;
        const dy = point1.y - point2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    clearHandSkeleton() {
        this.skeletonCtx.clearRect(0, 0, this.skeletonCanvas.width, this.skeletonCanvas.height);
    }

    drawHandSkeletons(results) {
        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            const landmarks = results.multiHandLandmarks[i];
            const handedness = results.multiHandedness ? results.multiHandedness[i].label : 'Unknown';
            const confidence = results.multiHandedness ? results.multiHandedness[i].score : 1.0;

            // 镜像翻转手部数据，使左右手显示位置正确
            const mirroredLandmarks = landmarks.map(landmark => ({
                x: 1 - landmark.x,
                y: landmark.y,
                z: landmark.z
            }));

            // 根据 handedness 设置颜色
            // 注意：由于视频已经镜像，用户看到的左右与系统识别的左右是相反的
            // 当用户举起右手时，系统识别为"Left"，当用户举起左手时，系统识别为"Right"
            const baseColor = handedness === 'Left' ? [255, 100, 0] : [0, 255, 0]; // Right hand: green, Left hand: orange
            const alpha = Math.max(0.3, confidence);
            const color = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, ${alpha})`;

            this.drawHandSkeleton(mirroredLandmarks, color, confidence);
        }
    }

    drawHandSkeleton(landmarks, color = 'rgba(0, 255, 0, 0.8)', confidence = 1.0) {
        const ctx = this.skeletonCtx;

        const connections = [
            [0, 1], [1, 2], [2, 3], [3, 4],
            [0, 5], [5, 6], [6, 7], [7, 8],
            [0, 9], [9, 10], [10, 11], [11, 12],
            [0, 13], [13, 14], [14, 15], [15, 16],
            [0, 17], [17, 18], [18, 19], [19, 20],
            [5, 9], [9, 13], [13, 17]
        ];

        const lineWidth = confidence > 0.8 ? 3 : confidence > 0.6 ? 2 : 1;

        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 绘制连接线（x轴已经通过 mirroredLandmarks 处理了镜像）
        connections.forEach(([start, end]) => {
            const startPoint = landmarks[start];
            const endPoint = landmarks[end];

            const startX = startPoint.x * this.skeletonCanvas.width;
            const startY = startPoint.y * this.skeletonCanvas.height;
            const endX = endPoint.x * this.skeletonCanvas.width;
            const endY = endPoint.y * this.skeletonCanvas.height;

            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
        });

        // 绘制关键点
        ctx.fillStyle = color;
        landmarks.forEach((landmark, index) => {
            const x = landmark.x * this.skeletonCanvas.width;
            const y = landmark.y * this.skeletonCanvas.height;

            let radius = 3;
            if ([0].includes(index)) {
                radius = 5;
            } else if ([4, 8, 12, 16, 20].includes(index)) {
                radius = 4;
            }

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, 2 * Math.PI);
            ctx.fill();

            // 特殊标注拇指和食指尖
            if ([4, 8].includes(index)) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
                ctx.stroke();
            }
        });
    }

    drawLine(from, to) {
        // 绘制到缓存canvas（镜像翻转，与视频显示保持一致）
        this.drawingCacheCtx.save();
        this.drawingCacheCtx.scale(-1, 1);

        // 设置绘画样式
        this.drawingCacheCtx.strokeStyle = this.currentColor;
        this.drawingCacheCtx.lineWidth = this.lineWidth;
        this.drawingCacheCtx.lineCap = 'round';
        this.drawingCacheCtx.lineJoin = 'round';

        // 绘制线条（镜像翻转，与视频显示保持一致）
        this.drawingCacheCtx.beginPath();
        this.drawingCacheCtx.moveTo(-from.x, from.y);
        this.drawingCacheCtx.lineTo(-to.x, to.y);
        this.drawingCacheCtx.stroke();

        this.drawingCacheCtx.restore();
    }

    clearCanvas() {
        // 清除绘画缓存，下次渲染时就没有绘画内容了
        this.drawingCacheCtx.clearRect(0, 0, this.drawingCache.width, this.drawingCache.height);
        this.updateStatus('画布已清除', 'ready');
    }

    saveImage() {
        // 创建一个新的canvas来合成最终图像
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;

        // 绘制视频帧（镜像翻转）
        tempCtx.save();
        tempCtx.scale(-1, 1);
        tempCtx.drawImage(this.video, -tempCanvas.width, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.restore();

        // 绘制骨架内容（不镜像翻转，因为我们已经处理过了）
        tempCtx.drawImage(this.skeletonCanvas, 0, 0);

        // 绘制画布内容（不镜像翻转）
        tempCtx.drawImage(this.drawingCache, 0, 0);

        // 下载图像
        const link = document.createElement('a');
        link.download = `gesture-drawing-${Date.now()}.png`;
        link.href = tempCanvas.toDataURL();
        link.click();
    }

    updateStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `status ${type}`;
    }

    updateDrawingStatus(message, type = 'info') {
        if (!this.drawingInfo) return;

        const colors = {
            'info': '#007bff',
            'success': '#28a745',
            'warning': '#ffc107',
            'error': '#dc3545'
        };

        this.drawingInfo.innerHTML = message;
        this.drawingInfo.style.color = colors[type] || colors.info;
    }

    updateDebug(message) {
        this.debugInfo.innerHTML = message;
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new HandGestureDrawing();
});