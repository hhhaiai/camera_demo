class HandGestureDrawing {
    constructor() {
        this.video = document.getElementById('video');
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.status = document.getElementById('status');
        this.debugInfo = document.getElementById('debugInfo');

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
        // 不在CSS中镜像翻转，改为在绘制时处理

        // 将骨架canvas添加到视频容器中
        const videoContainer = document.querySelector('.video-container');
        videoContainer.appendChild(this.skeletonCanvas);

        this.isDrawing = false;
        this.lastPoint = null;
        this.previousPoint = null; // 用于平滑算法的历史点
        this.lastDrawTime = 0; // 用于计算绘画速度
        this.currentColor = '#ff0000';
        this.lineWidth = 8; // 增加线条粗细，更容易看到

        // 🎨 创建绘画缓存canvas，用于保存绘画内容
        this.drawingCache = document.createElement('canvas');
        this.drawingCacheCtx = this.drawingCache.getContext('2d');
        this.drawingCache.width = 960;
        this.drawingCache.height = 720;

        this.hands = null;
        this.camera = null;
        this.frameCount = 0;

        // 添加手势识别稳定性参数 - 进一步优化响应速度
        this.gestureStabilityBuffer = [];
        this.gestureBufferSize = 1; // 最小缓冲区，最快响应
        this.lastGestureTime = 0;
        this.gestureDebounceTime = 16; // 约60fps的防抖时间，更快响应

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

            // 检查浏览器兼容性
            if (!this.checkBrowserSupport()) {
                throw new Error('浏览器不支持所需功能');
            }

            // 改进的摄像头权限请求
            const stream = await this.getUserMedia({
                video: {
                    width: 960,
                    height: 720,
                    facingMode: 'user' // 优先使用前置摄像头
                }
            });

            this.video.srcObject = stream;
            this.updateDebug('摄像头流已设置');

            // 等待视频加载
            await new Promise((resolve, reject) => {
                this.video.onloadedmetadata = resolve;
                this.video.onerror = reject;
                // 添加超时处理
                setTimeout(() => reject(new Error('视频加载超时')), 10000);
            });

            this.updateDebug('正在初始化MediaPipe Hands...');

            // 检查MediaPipe是否可用
            if (typeof Hands === 'undefined') {
                throw new Error('MediaPipe Hands库未加载，请检查网络连接');
            }

            // 初始化MediaPipe Hands with better error handling
            try {
                this.hands = new Hands({
                    locateFile: (file) => {
                        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`;
                    }
                });

                this.hands.setOptions({
                    maxNumHands: 2, // 恢复双手检测以识别所有手指
                    modelComplexity: 1, // 提高模型复杂度以获得更好的手指识别
                    minDetectionConfidence: 0.7, // 提高检测置信度以获得更准确的手指识别
                    minTrackingConfidence: 0.6   // 提高跟踪置信度
                });

                this.hands.onResults((results) => this.onResults(results));

                this.updateDebug('MediaPipe Hands 已初始化');
            } catch (mpError) {
                throw new Error(`MediaPipe初始化失败: ${mpError.message}`);
            }

            // 检查Camera类是否可用
            if (typeof Camera === 'undefined') {
                throw new Error('MediaPipe Camera库未加载，请检查网络连接');
            }

            // 初始化摄像头 with performance optimization
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

                    // 减少调试信息更新频率以提高性能
                    if (this.frameCount % 60 === 0) {
                        this.updateDebug(`处理帧数: ${this.frameCount} | FPS: ${this.fps}`);
                    }

                    // 优化处理频率：每帧都处理以获得最佳响应速度
                    try {
                        await this.hands.send({ image: this.video });
                    } catch (error) {
                        console.warn('手势识别处理错误:', error);
                    }
                },
                width: 960,
                height: 720
            });

            await this.camera.start();

            this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
            this.updateDebug('摄像头启动成功，等待手势检测...');
            document.getElementById('startBtn').disabled = true;

        } catch (error) {
            console.error('启动摄像头失败:', error);
            const errorMessage = this.getErrorMessage(error);
            this.updateStatus(errorMessage, 'error');
            this.updateDebug(`错误详情: ${error.message}`);

            // 显示重试按钮
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
            // 🎨 实现视频滤镜绘画效果
            // 1. 绘制视频背景
            this.ctx.save();
            this.ctx.scale(-1, 1); // 镜像翻转
            this.ctx.drawImage(this.video, -this.canvas.width, 0, this.canvas.width, this.canvas.height);
            this.ctx.restore();

            // 2. 叠加绘画缓存（之前绘制的内容）
            this.ctx.drawImage(this.drawingCache, 0, 0);

            // 3. 清除骨架canvas
            this.clearHandSkeleton();

            // 4. 绘制手部骨架到骨架层
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                this.drawHandSkeletons(results);
            }

            // 处理手势识别
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                // 检测停止手势（食指指向掌心）
                const stopGestureDetected = this.detectStopGesture(results.multiHandLandmarks[0]);
                if (stopGestureDetected && this.isDrawing) {
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.updateStatus('检测到停止手势，已停止绘画', 'ready');
                    this.updateDebug('检测到停止手势：食指指向掌心');
                    return;
                }

                // 处理单手绘画逻辑
                const landmarks = results.multiHandLandmarks[0];
                // 由于视频镜像翻转，需要反转左右手标识
                const rawHandedness = results.multiHandedness ? results.multiHandedness[0].label : 'Unknown';
                const handedness = rawHandedness === 'Left' ? 'Right' : rawHandedness === 'Right' ? 'Left' : 'Unknown';

                // 获取关键点
                const thumbTip = landmarks[4];      // 拇指尖
                const thumbIP = landmarks[3];       // 拇指指间关节
                const indexTip = landmarks[8];      // 食指尖
                const indexPIP = landmarks[6];      // 食指近端指间关节
                const middleTip = landmarks[12];    // 中指尖

                // 使用食指尖作为绘画点（镜像翻转坐标）
                const drawPoint = {
                    x: (1 - indexTip.x) * this.canvas.width,
                    y: indexTip.y * this.canvas.height
                };

                // 改进的捏合检测算法
                const gestureData = this.analyzePinchGesture(landmarks);

                // 使用稳定性缓冲区减少误触发
                const stableGesture = this.stabilizeGesture(gestureData.isPinching);

                // 实时调试信息，帮助诊断问题
                this.updateDebug(`
                    检测到${handedness}手 | FPS: ${this.fps} |
                    手掌朝向: ${gestureData.palmFacing ? '面向摄像头' : '侧向/背向'} |
                    捏合状态: ${gestureData.isPinching ? '是' : '否'} |
                    稳定手势: ${stableGesture ? '是' : '否'} |
                    置信度: ${gestureData.confidence.toFixed(2)} |
                    绘画状态: ${this.isDrawing ? '绘画中' : '未绘画'} |
                    距离: ${gestureData.tipDistance.toFixed(3)} < ${gestureData.threshold.toFixed(3)}
                `);

                // 防抖处理
                const currentTime = Date.now();
                if (currentTime - this.lastGestureTime < this.gestureDebounceTime) {
                    return;
                }

                // 检查是否应该启动绘画模式（捏合手势）- 进一步降低要求
                if (stableGesture) {
                    if (!this.isDrawing) {
                        this.isDrawing = true;
                        this.lastPoint = drawPoint;
                        this.previousPoint = null; // 重置历史点
                        this.lastDrawTime = 0; // 重置绘画时间
                        this.updateStatus('绘画模式已激活，用食指画画', 'drawing');
                        this.lastGestureTime = currentTime;
                    }
                }

                // 如果已经在绘画模式，用食指跟踪绘画（不需要持续捏合）
                if (this.isDrawing && gestureData.palmFacing) {
                    if (this.lastPoint) {
                        // 绘制线条
                        this.drawLine(this.lastPoint, drawPoint);
                        this.lastPoint = drawPoint;
                    } else {
                        // 如果没有上一个点，设置当前点为起始点
                        this.lastPoint = drawPoint;
                    }
                } else if (this.isDrawing && !gestureData.palmFacing) {
                    // 手掌不再面向摄像头，停止绘画模式
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.previousPoint = null;
                    this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
                    this.lastGestureTime = currentTime;
                }
            } else {
                // 没有检测到手部
                if (this.frameCount % 60 === 0) {
                    this.updateDebug(`未检测到手部，请伸出手掌显示骨架 | FPS: ${this.fps}`);
                }

                if (this.isDrawing) {
                    this.isDrawing = false;
                    this.lastPoint = null;
                    this.previousPoint = null;
                    this.updateStatus('摄像头已启动，伸出手掌显示骨架，捏合开始绘画', 'ready');
                }

                // 清空稳定性缓冲区
                this.gestureStabilityBuffer = [];
            }
        } catch (error) {
            console.warn('手势处理错误:', error);
            this.updateDebug(`手势处理错误: ${error.message}`);
        }
    }

    analyzePinchGesture(landmarks) {
        const thumbTip = landmarks[4];
        const thumbIP = landmarks[3];
        const indexTip = landmarks[8];
        const indexPIP = landmarks[6];
        const middleTip = landmarks[12];
        const ringTip = landmarks[16];
        const pinkyTip = landmarks[20];
        const wrist = landmarks[0];

        // 检测手掌朝向
        const palmFacing = this.isHandFacingCamera(landmarks);

        // 计算拇指和食指尖之间的距离
        const tipDistance = this.calculateDistance(thumbTip, indexTip);

        // 计算拇指和食指关节之间的距离作为参考
        const jointDistance = this.calculateDistance(thumbIP, indexPIP);

        // 非常宽松的阈值，更容易触发
        const threshold = jointDistance * 1.2; // 进一步增加阈值

        // 检查是否为捏合手势
        const isPinching = tipDistance < threshold;

        // 检查其他手指状态
        const middleFingerDown = middleTip.y > indexPIP.y;
        const ringFingerDown = ringTip.y > indexPIP.y;
        const pinkyFingerDown = pinkyTip.y > indexPIP.y;

        // 简化的置信度计算，提高响应速度
        let confidence = 0;
        if (isPinching && palmFacing) {
            confidence = 0.8; // 如果检测到捏合且手掌面向摄像头，直接给高置信度
            if (middleFingerDown) confidence += 0.05;
            if (ringFingerDown) confidence += 0.05;
            if (pinkyFingerDown) confidence += 0.05;
        } else if (isPinching) {
            confidence = 0.4; // 只检测到捏合，给中等置信度
        }

        return {
            isPinching: isPinching, // 简化：只要检测到捏合就返回true
            tipDistance,
            threshold,
            confidence,
            palmFacing,
            middleFingerDown,
            ringFingerDown,
            pinkyFingerDown
        };
    }

    // 检测手掌是否面向摄像头
    isHandFacingCamera(landmarks) {
        // 使用手掌关键点计算法向量
        const wrist = landmarks[0];
        const indexMCP = landmarks[5];  // 食指掌指关节
        const pinkyMCP = landmarks[17]; // 小指掌指关节
        const middleMCP = landmarks[9]; // 中指掌指关节

        // 计算手掌平面的两个向量
        const vector1 = {
            x: indexMCP.x - wrist.x,
            y: indexMCP.y - wrist.y,
            z: indexMCP.z - wrist.z
        };

        const vector2 = {
            x: pinkyMCP.x - wrist.x,
            y: pinkyMCP.y - wrist.y,
            z: pinkyMCP.z - wrist.z
        };

        // 计算法向量（叉积）
        const normal = {
            x: vector1.y * vector2.z - vector1.z * vector2.y,
            y: vector1.z * vector2.x - vector1.x * vector2.z,
            z: vector1.x * vector2.y - vector1.y * vector2.x
        };

        // 摄像头方向向量（假设摄像头在z轴正方向）
        const cameraDirection = { x: 0, y: 0, z: 1 };

        // 计算法向量与摄像头方向的点积
        const dotProduct = normal.x * cameraDirection.x +
            normal.y * cameraDirection.y +
            normal.z * cameraDirection.z;

        // 如果点积为正，说明手掌面向摄像头
        return dotProduct > 0;
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
        // 最简化的稳定性检查，直接返回当前手势状态以获得最快响应
        return currentGesture;
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

            // 根据左右手使用不同颜色，考虑镜像翻转
            const actualHandedness = handedness === 'Left' ? 'Right' : handedness === 'Right' ? 'Left' : 'Unknown';
            const baseColor = actualHandedness === 'Left' ? [0, 255, 0] : [255, 100, 0]; // 左手绿色，右手橙色

            // 根据置信度调整透明度
            const alpha = Math.max(0.3, confidence); // 最小透明度0.3
            const color = `rgba(${baseColor[0]}, ${baseColor[1]}, ${baseColor[2]}, ${alpha})`;

            this.drawHandSkeleton(landmarks, color, confidence);
        }
    }

    drawHandSkeleton(landmarks, color = 'rgba(0, 255, 0, 0.8)', confidence = 1.0) {
        const ctx = this.skeletonCtx;

        // 手部连接关系定义
        const connections = [
            // 拇指
            [0, 1], [1, 2], [2, 3], [3, 4],
            // 食指
            [0, 5], [5, 6], [6, 7], [7, 8],
            // 中指
            [0, 9], [9, 10], [10, 11], [11, 12],
            // 无名指
            [0, 13], [13, 14], [14, 15], [15, 16],
            // 小指
            [0, 17], [17, 18], [18, 19], [19, 20],
            // 手掌连接
            [5, 9], [9, 13], [13, 17]
        ];

        // 根据置信度调整线条粗细
        const lineWidth = confidence > 0.8 ? 3 : confidence > 0.6 ? 2 : 1;

        // 绘制连接线
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        connections.forEach(([start, end]) => {
            const startPoint = landmarks[start];
            const endPoint = landmarks[end];

            // 镜像翻转坐标
            const startX = (1 - startPoint.x) * this.skeletonCanvas.width;
            const startY = startPoint.y * this.skeletonCanvas.height;
            const endX = (1 - endPoint.x) * this.skeletonCanvas.width;
            const endY = endPoint.y * this.skeletonCanvas.height;

            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
        });

        // 绘制关键点
        ctx.fillStyle = color;
        landmarks.forEach((landmark, index) => {
            // 镜像翻转坐标
            const x = (1 - landmark.x) * this.skeletonCanvas.width;
            const y = landmark.y * this.skeletonCanvas.height;

            // 根据关键点类型调整大小
            let radius = 3;
            if ([0].includes(index)) { // 手腕
                radius = 5;
            } else if ([4, 8, 12, 16, 20].includes(index)) { // 手指尖
                radius = 4;
            }

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, 2 * Math.PI);
            ctx.fill();

            // 特殊标注拇指和食指尖（用于捏合检测）
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
        // 🎨 绘制到缓存canvas，实现持久的视频滤镜效果
        this.drawingCacheCtx.save();

        // 设置绘画样式
        this.drawingCacheCtx.strokeStyle = this.currentColor;
        this.drawingCacheCtx.lineWidth = this.lineWidth;
        this.drawingCacheCtx.lineCap = 'round';
        this.drawingCacheCtx.lineJoin = 'round';

        // 添加发光效果，使绘画在视频上更明显
        this.drawingCacheCtx.shadowColor = this.currentColor;
        this.drawingCacheCtx.shadowBlur = 8;
        this.drawingCacheCtx.shadowOffsetX = 0;
        this.drawingCacheCtx.shadowOffsetY = 0;

        // 绘制主线条
        this.drawingCacheCtx.beginPath();
        this.drawingCacheCtx.moveTo(from.x, from.y);
        this.drawingCacheCtx.lineTo(to.x, to.y);
        this.drawingCacheCtx.stroke();

        // 绘制加强线条（多层叠加效果）
        this.drawingCacheCtx.globalCompositeOperation = 'screen';
        this.drawingCacheCtx.lineWidth = this.lineWidth - 2;
        this.drawingCacheCtx.shadowBlur = 4;
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

        // 绘制骨架内容（已经是镜像翻转的）
        tempCtx.drawImage(this.skeletonCanvas, 0, 0);

        // 绘制画布内容（镜像翻转）
        tempCtx.save();
        tempCtx.scale(-1, 1);
        tempCtx.drawImage(this.canvas, -tempCanvas.width, 0);
        tempCtx.restore();

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

    updateDebug(message) {
        this.debugInfo.innerHTML = message;
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new HandGestureDrawing();
});