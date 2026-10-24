package com.roadguard.app.activities

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.roadguard.app.BuildConfig
import com.roadguard.app.R
import com.roadguard.app.data.ReportQueue
import com.roadguard.app.data.Session
import com.roadguard.app.data.Settings
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.databinding.ActivitySettingsBinding
import com.roadguard.app.ui.ServerDialog
import com.roadguard.app.ui.padForSystemBars
import com.roadguard.app.ui.visible
import kotlinx.coroutines.launch

class SettingsActivity : AppCompatActivity() {

    companion object {
        fun intent(context: Context) = Intent(context, SettingsActivity::class.java)
    }

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.topBar.padForSystemBars(top = true)
        binding.scroll.padForSystemBars(top = false, bottom = true)
        binding.btnBack.setOnClickListener { finish() }

        // Language. Changing it recreates the screen in the new language.
        binding.radioLanguage.check(
            when (pickedLanguage()) {
                "en" -> R.id.radioLangEnglish
                "hi" -> R.id.radioLangHindi
                else -> R.id.radioLangDefault
            }
        )
        binding.radioLanguage.setOnCheckedChangeListener { _, id ->
            val tag = when (id) {
                R.id.radioLangEnglish -> "en"
                R.id.radioLangHindi -> "hi"
                else -> ""
            }
            if (tag != pickedLanguage()) {
                AppCompatDelegate.setApplicationLocales(
                    if (tag.isEmpty()) LocaleListCompat.getEmptyLocaleList() else LocaleListCompat.forLanguageTags(tag)
                )
            }
        }

        // Driving
        binding.switchVoice.isChecked = Settings.voiceAlerts
        binding.switchVoice.setOnCheckedChangeListener { _, on -> Settings.voiceAlerts = on }
        binding.switchVibrate.isChecked = Settings.vibrateAlerts
        binding.switchVibrate.setOnCheckedChangeListener { _, on -> Settings.vibrateAlerts = on }
        binding.switchRequireBump.isChecked = Settings.requireBump
        binding.switchRequireBump.setOnCheckedChangeListener { _, on -> Settings.requireBump = on }
        binding.toggleSensitivity.check(
            when (Settings.bumpSensitivity) {
                0 -> R.id.btnSensLow
                2 -> R.id.btnSensHigh
                else -> R.id.btnSensNormal
            }
        )
        binding.toggleSensitivity.addOnButtonCheckedListener { _, id, checked ->
            if (!checked) return@addOnButtonCheckedListener
            Settings.bumpSensitivity = when (id) {
                R.id.btnSensLow -> 0
                R.id.btnSensHigh -> 2
                else -> 1
            }
        }
        binding.btnShowTip.setOnClickListener {
            Settings.showMountTip = true
            Toast.makeText(this, R.string.settings_tip_toast, Toast.LENGTH_SHORT).show()
        }

        // Uploads
        binding.switchWifi.isChecked = Settings.wifiOnlyUploads
        binding.switchWifi.setOnCheckedChangeListener { _, on ->
            Settings.wifiOnlyUploads = on
            ReportQueue.scheduleUpload(this)
        }
        binding.btnSendNow.setOnClickListener {
            ReportQueue.scheduleUpload(this)
            Toast.makeText(this, R.string.settings_send_toast, Toast.LENGTH_SHORT).show()
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                RoadGuardDatabase.get(this@SettingsActivity).dao().observePendingCount().collect { n ->
                    binding.txtQueue.text = if (n == 0) getString(R.string.settings_queue_empty)
                    else resources.getQuantityString(R.plurals.settings_queue_waiting, n, n)
                    binding.btnSendNow.visible(n > 0)
                }
            }
        }

        // Server: drivers never need this, and changing it signs them out. Debug builds only.
        binding.txtServerSection.visible(BuildConfig.DEBUG)
        binding.cardServer.visible(BuildConfig.DEBUG)
        binding.btnChangeServer.setOnClickListener {
            ServerDialog.show(this) {
                showServer()
                if (!Session.canUseApp) {
                    startActivity(
                        Intent(this, LoginActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    )
                }
            }
        }
        binding.btnTestServer.setOnClickListener { ServerDialog.test(this) }

        // Account
        binding.btnCreateAccount.setOnClickListener { startActivity(LoginActivity.upgradeIntent(this)) }
        binding.btnSignOut.setOnClickListener { com.roadguard.app.data.SignOut.confirm(this, lifecycleScope) }

        binding.txtAbout.text = getString(R.string.settings_about, BuildConfig.VERSION_NAME)
    }

    override fun onResume() {
        super.onResume()
        showServer()
        binding.txtAccount.text = when {
            Session.isGuest -> getString(R.string.settings_account_guest)
            else -> getString(R.string.settings_account_signed_in, Session.userEmail ?: Session.userName)
        }
        binding.btnCreateAccount.visible(Session.isGuest)
    }

    /** "en", "hi", or "" when the app follows the phone's language. */
    private fun pickedLanguage(): String {
        val picked = AppCompatDelegate.getApplicationLocales()
        if (picked.isEmpty()) return ""
        return if (picked.get(0)?.language == "hi") "hi" else "en"
    }

    private fun showServer() {
        binding.txtServerUrl.text = Session.serverUrl
    }
}
