package com.hytools.hang2048.apk

import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 沉浸式显示。
 *
 * 目标：让页面内容延伸到状态栏与导航栏区域，由页面自身的
 * env(safe-area-inset-*) 决定内边距，从而在刘海屏/手势条机型上
 * 既不浪费屏幕，也不会把内容压到系统栏下面。
 *
 * 注意这里用的是「隐藏系统栏」而不是「全屏 + 半透明」，
 * 因为后者在部分国产 ROM 上表现不一致。
 */
object WindowCompatHelper {

    fun applyImmersive(window: Window) {
        // 允许内容绘制到系统栏区域
        WindowCompat.setDecorFitsSystemWindows(window, false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController
            if (controller != null) {
                // 只隐藏状态栏与导航栏的「背景」，图标仍可见（避免用户失去系统信息）
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }

        // 状态栏/导航栏透明
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT

        // 深色图标（游戏背景是浅色）
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = true
        controller.isAppearanceLightNavigationBars = true
    }
}
