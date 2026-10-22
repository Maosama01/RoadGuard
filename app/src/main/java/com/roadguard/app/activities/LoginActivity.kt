package com.roadguard.app.activities

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.Patterns
import android.view.inputmethod.EditorInfo
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import com.roadguard.app.BuildConfig
import androidx.lifecycle.lifecycleScope
import com.roadguard.app.R
import com.roadguard.app.data.ReportQueue
import com.roadguard.app.data.Session
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.AuthResponse
import com.roadguard.app.data.api.GuestRequest
import com.roadguard.app.data.api.LoginRequest
import com.roadguard.app.data.api.RegisterRequest
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.databinding.ActivityLoginBinding
import com.roadguard.app.ui.ServerDialog
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.padForSystemBars
import com.roadguard.app.ui.visible
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    companion object {
        private const val EXTRA_UPGRADE = "upgrade"

        /** Opens straight into "create account" for a guest who wants to keep their points. */
        fun upgradeIntent(context: Context) =
            Intent(context, LoginActivity::class.java).putExtra(EXTRA_UPGRADE, true)
    }

    private lateinit var binding: ActivityLoginBinding
    private var registerMode = false
    private val isUpgrade get() = intent.getBooleanExtra(EXTRA_UPGRADE, false)

    override fun onCreate(savedInstanceState: Bundle?) {
        // Light status-bar icons over the dark hero.
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.hero.padForSystemBars(top = true)
        binding.scroll.padForSystemBars(top = false, bottom = true, keyboard = true)

        bindStep(binding.step1.txtStepNumber, binding.step1.txtStepTitle, binding.step1.txtStepBody, "1",
            R.string.login_step1_title, R.string.login_step1_body)
        bindStep(binding.step2.txtStepNumber, binding.step2.txtStepTitle, binding.step2.txtStepBody, "2",
            R.string.login_step2_title, R.string.login_step2_body)
        bindStep(binding.step3.txtStepNumber, binding.step3.txtStepTitle, binding.step3.txtStepBody, "3",
            R.string.login_step3_title, R.string.login_step3_body)

        binding.btnGuest.setOnClickListener { startAsGuest() }
        binding.btnShowSignIn.setOnClickListener { showForm(register = false) }
        binding.btnShowRegister.setOnClickListener { showForm(register = true) }
        binding.btnSwitchMode.setOnClickListener { showForm(!registerMode) }
        binding.btnBack.setOnClickListener {
            if (isUpgrade) finish() else showChoice()
        }
        binding.btnSubmit.setOnClickListener { submit() }
        binding.etPassword.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else false
        }
        // Which server the app talks to is a developer setting: release builds don't show it.
        binding.txtServer.visible(BuildConfig.DEBUG)
        binding.txtServer.setOnClickListener { ServerDialog.show(this) { updateServerLine() } }
        updateServerLine()
        Session.lastEmail?.let { binding.etEmail.setText(it) }
        setUpLanguageButton()

        // Back on the form returns to the first screen instead of closing the app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.groupForm.visibility == android.view.View.VISIBLE && !isUpgrade) {
                    showChoice()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (isUpgrade) {
            binding.groupSteps.visible(false)
            binding.txtHeroTitle.setText(R.string.login_upgrade_title)
            binding.txtHeroBody.setText(R.string.login_upgrade_body)
            showForm(register = true)
        }
    }

    private fun bindStep(
        number: android.widget.TextView,
        title: android.widget.TextView,
        body: android.widget.TextView,
        n: String,
        @StringRes t: Int,
        @StringRes b: Int,
    ) {
        number.text = n
        title.setText(t)
        body.setText(b)
    }

    /** Shows the other language, so one tap switches: "हिन्दी" while in English, "English" while in Hindi. */
    private fun setUpLanguageButton() {
        val inHindi = Ui.uiLocale(this).language == "hi"
        binding.btnLanguage.setText(if (inHindi) R.string.language_english else R.string.language_hindi)
        binding.btnLanguage.setOnClickListener {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(if (inHindi) "en" else "hi"))
        }
    }

    private fun updateServerLine() {
        binding.txtServer.text = getString(R.string.login_server_line, Session.serverUrl)
    }

    private fun showChoice() {
        binding.groupForm.visible(false)
        binding.groupChoice.visible(true)
        binding.groupSteps.visible(true)
        binding.txtError.visible(false)
    }

    private fun showForm(register: Boolean) {
        registerMode = register
        binding.groupChoice.visible(false)
        binding.groupSteps.visible(false)
        binding.groupForm.visible(true)
        binding.tilName.visible(register)
        binding.txtError.visible(false)
        binding.txtFormTitle.setText(if (register) R.string.login_title_register else R.string.login_sign_in)
        binding.txtFormSubtitle.setText(
            if (register) {
                if (isUpgrade) R.string.login_subtitle_upgrade else R.string.login_subtitle_register
            } else R.string.login_subtitle_sign_in
        )
        binding.btnSubmit.setText(if (register) R.string.action_create_account else R.string.login_sign_in)
        binding.btnSwitchMode.setText(if (register) R.string.login_switch_to_sign_in else R.string.login_switch_to_register)
        binding.btnSwitchMode.visible(!isUpgrade)
        when {
            register -> binding.etName.requestFocus()
            binding.etEmail.text.isNullOrEmpty() -> binding.etEmail.requestFocus()
            else -> binding.etPassword.requestFocus()
        }
    }

    private fun submit() {
        val name = binding.etName.text?.toString()?.trim().orEmpty()
        val email = binding.etEmail.text?.toString()?.trim().orEmpty()
        val password = binding.etPassword.text?.toString().orEmpty()

        binding.tilName.error = null
        binding.tilEmail.error = null
        binding.tilPassword.error = null
        var ok = true
        if (registerMode && name.length < 2) {
            binding.tilName.error = getString(R.string.login_error_name)
            ok = false
        }
        if (!Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            binding.tilEmail.error = getString(R.string.login_error_email)
            ok = false
        }
        if (password.length < (if (registerMode) 6 else 1)) {
            binding.tilPassword.error = getString(
                if (registerMode) R.string.login_error_password_short else R.string.login_error_password_empty
            )
            ok = false
        }
        if (!ok) return

        // A guest upgrading keeps their token so the server converts that account in place.
        if (registerMode && !isUpgrade) Session.signOut()
        authenticate {
            if (registerMode) apiCall { register(RegisterRequest(name, email, password)) }
            else apiCall { login(LoginRequest(email, password)) }
        }
    }

    /**
     * "Start scanning" always works. If the server can't be reached the app runs as an offline
     * guest: drives and reports work, and the account is created once there's a connection.
     */
    private fun startAsGuest() {
        setBusy(true)
        lifecycleScope.launch {
            val r = apiCall { guest(GuestRequest(Session.deviceId)) }
            val token = (r as? ApiResult.Ok)?.value?.token
            val user = (r as? ApiResult.Ok)?.value?.user
            if (token != null && user != null) {
                Session.saveAuth(token, user)
            } else {
                Session.offlineGuest = true
                Toast.makeText(this@LoginActivity, R.string.login_offline_started, Toast.LENGTH_LONG).show()
            }
            ReportQueue.scheduleUpload(this@LoginActivity)
            openHome()
        }
    }

    private fun openHome() {
        startActivity(
            Intent(this, HomeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        )
        finish()
    }

    private fun authenticate(call: suspend () -> ApiResult<AuthResponse>) {
        setBusy(true)
        lifecycleScope.launch {
            when (val r = call()) {
                is ApiResult.Ok -> {
                    val token = r.value.token
                    val user = r.value.user
                    if (token != null && user != null) {
                        Session.saveAuth(token, user)
                        ReportQueue.scheduleUpload(this@LoginActivity)
                        openHome()
                    } else {
                        showError(r.value.message ?: getString(R.string.login_failed))
                    }
                }
                is ApiResult.Err -> showError(
                    if (r.offline && BuildConfig.DEBUG) getString(R.string.login_error_offline, r.message, Session.serverUrl) else r.message
                )
            }
            setBusy(false)
        }
    }

    private fun showError(message: String) {
        if (binding.groupForm.visibility != android.view.View.VISIBLE) {
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                .setTitle(R.string.login_couldnt_start)
                .setMessage(message)
                .setPositiveButton(R.string.action_ok, null)
                .apply {
                    if (BuildConfig.DEBUG) {
                        setNeutralButton(R.string.action_change_server) { _, _ -> ServerDialog.show(this@LoginActivity) { updateServerLine() } }
                    }
                }
                .show()
            return
        }
        binding.txtError.text = message
        binding.txtError.visible(true)
    }

    private fun setBusy(busy: Boolean) {
        binding.progress.visible(busy)
        binding.btnGuest.isEnabled = !busy
        binding.btnSubmit.isEnabled = !busy
        binding.btnShowSignIn.isEnabled = !busy
        binding.btnShowRegister.isEnabled = !busy
        binding.btnSwitchMode.isEnabled = !busy
        binding.btnBack.isEnabled = !busy
        binding.btnLanguage.isEnabled = !busy
        binding.txtServer.isEnabled = !busy
    }
}
