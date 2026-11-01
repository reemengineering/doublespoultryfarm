package com.reem.doublespoultryadmin

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.*
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.appbar.MaterialToolbar

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var offlineBanner: TextView
    private lateinit var prefs: PrefsManager
    private lateinit var toolbar: MaterialToolbar

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        toolbar = findViewById(R.id.toolbar)
        setSupportActionBar(toolbar)

        prefs = PrefsManager(this)
        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        offlineBanner = findViewById(R.id.offlineBanner)

        setupWebView()

        swipeRefresh.setOnRefreshListener {
            loadContent()
        }

        loadContent()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

        // The offline asset page (file:///android_asset/www/) is plain JS:
        // ES-module imports are blocked over file://, so it must never rely on
        // the bundled app.js. The bridge gives its RETRY button a way back to
        // normal loading without a page reload.
        webView.addJavascriptInterface(OfflineBridge(), "AndroidApp")

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    showOffline()
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                swipeRefresh.isRefreshing = false
            }
        }
    }

    private fun loadContent() {
        val serverUrl = prefs.getServerUrl()
        if (serverUrl != null) {
            offlineBanner.visibility = View.GONE
            webView.loadUrl(serverUrl)
        } else {
            showOffline()
            ServerConfigDialog(this, prefs).show {
                loadContent()
            }
        }
    }

    private fun showOffline() {
        offlineBanner.visibility = View.VISIBLE
        swipeRefresh.isRefreshing = false
        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onCreateOptionsMenu(menu: Menu?): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_change_server -> {
                ServerConfigDialog(this, prefs).show { loadContent() }
                true
            }
            R.id.action_refresh -> {
                loadContent()
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack() && webView.url?.startsWith("file://") == false) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    /** JS bridge for the offline asset page's RETRY button. */
    private inner class OfflineBridge {
        @android.webkit.JavascriptInterface
        fun retry() {
            runOnUiThread { loadContent() }
        }
    }
}
