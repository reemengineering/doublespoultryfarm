package com.reem.doublespoultryadmin

import android.app.AlertDialog
import android.content.Context
import android.view.LayoutInflater
import android.widget.EditText

class ServerConfigDialog(private val context: Context, private val prefs: PrefsManager) {
    fun show(onSaved: () -> Unit) {
        val view = LayoutInflater.from(context).inflate(R.layout.dialog_server_config, null)
        val etIp = view.findViewById<EditText>(R.id.etIp)
        val etPort = view.findViewById<EditText>(R.id.etPort)
        etIp.setText(prefs.serverIp ?: "")
        etPort.setText(prefs.serverPort ?: "3001")

        AlertDialog.Builder(context)
            .setTitle("Server Configuration")
            .setMessage("Enter Flask server IP and Port")
            .setView(view)
            .setPositiveButton("Connect") { _, _ ->
                val ip = etIp.text.toString().trim()
                val port = etPort.text.toString().trim()
                if (ip.isNotEmpty() && port.isNotEmpty()) {
                    prefs.serverIp = ip
                    prefs.serverPort = port
                    onSaved()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
