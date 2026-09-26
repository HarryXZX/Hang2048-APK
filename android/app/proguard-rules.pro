# WebView 壳无需额外混淆规则。
# 注意：JavascriptInterface 暴露的方法在 release 下若开启混淆必须保留，
# 当前 minifyEnabled=false，故无需 keep 规则。
# 若将来开启混淆，请取消下面两行注释：

#-keepclassmembers class com.hytools.hang2048.apk.MainActivity$Bridge {
#    public *;
#}
