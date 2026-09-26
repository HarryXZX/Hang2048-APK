package com.hytools.hang2048.apk

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * 夯048 · Hang2048 —— Android 外壳
 *
 * 设计要点：
 *  · 纯本地 WebView，加载 assets/index.html，无网络访问
 *  · 零敏感权限；只用到 VIBRATE 做震动反馈
 *  · 通过 JavascriptInterface 暴露一个极小的桥（震动 + 返回键回传）
 *  · 关闭 WebView 自身的滚动/缩放/长按选择，把触摸事件完整交给游戏
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            // 关闭滚动条与过度滚动，避免与游戏手势冲突
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            setBackgroundColor(0xFFFAF8EF.toInt())
            // 长按不弹出文本选择菜单（游戏中长按无意义且干扰操作）
            isLongClickable = false
            isHapticFeedbackEnabled = false
        }

        setContentView(webView)
        configureWebSettings()
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            // 只允许本地资源；任何外部跳转一律拦截（本应用没有网络权限，这里是双保险）
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean = true
        }

        // 沉浸式：内容延伸到状态栏/导航栏区域，配合页面里的 env(safe-area-inset-*)
        WindowCompatHelper.applyImmersive(window)

        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }

        setupBackHandling()
    }

    private fun configureWebSettings() {
        webView.settings.apply {
            javaScriptEnabled = true                 // 游戏逻辑需要
            domStorageEnabled = true                 // 预留；当前版本不使用存档
            loadsImagesAutomatically = true

            // 关键：禁止一切会让 WebView 抢走触摸手势的行为
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = false                  // 页面自带 viewport 声明
            loadWithOverviewMode = false
            textZoom = 100                           // 不跟随系统字体缩放，避免布局错位

            // 不缓存、不联网
            cacheMode = WebSettings.LOAD_NO_CACHE
            blockNetworkLoads = true                 // 彻底禁止网络请求（双保险）
            allowFileAccess = true                   // 需要读 assets
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true

            // 禁用长按选择
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // 通过 setTextZoom 已处理缩放；长按选择在 WebView 上由
                // setLongClickable(false) + CSS user-select:none 共同抑制
            }
        }
    }

    /**
     * 返回键策略，与页面内 window.__h2048.onBackKey() 保持一致：
     *   1. 结算面板打开 -> 关面板
     *   2. 否则提示「再按一次退出」
     *   3. 第二次按下 -> 真正退出
     *
     * 页面返回 true 表示已处理；返回 false 表示交给系统（即退出）。
     */
    private fun setupBackHandling() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{return window.__h2048 && window.__h2048.onBackKey" +
                        " ? window.__h2048.onBackKey() : false;}catch(e){return false;}})()"
                ) { result ->
                    val handled = result != null && result.trim('"').equals("true", true)
                    if (!handled) {
                        // 页面不接管 -> 真正退出
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        webView.pauseTimers()
    }

    override fun onResume() {
        super.onResume()
        webView.resumeTimers()
        webView.onResume()
    }

    override fun onDestroy() {
        // 先把 WebView 从视图树里摘掉再 destroy，
        // 否则会打出 "WebView.destroy() called while WebView is still attached to window"
        // 警告，并且渲染进程可能以 crash 形式被回收。
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        webView.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // JS 桥：只暴露震动。刻意做得很小，减少攻击面。
    // -----------------------------------------------------------------------
    inner class Bridge {
        @JavascriptInterface
        fun vibrate(kind: String?) {
            val vibrator = getVibrator() ?: return
            // 三档反馈：合并（短促）/ 胜利（节奏上扬）/ 失败（低沉两下）
            val pattern: LongArray = when (kind) {
                "win" -> longArrayOf(0, 35, 55, 35, 55, 110)
                "lose" -> longArrayOf(0, 110, 70, 180)
                else -> longArrayOf(0, 12)
            }
            if (!vibrator.hasVibrator()) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        }
    }

    private fun getVibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = getSystemService(VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as? Vibrator
        }
    }
}
