package com.roadguard.app.activities

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.roadguard.app.R
import com.roadguard.app.data.Session
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.databinding.ActivityHomeBinding
import com.roadguard.app.fragments.HomeFragment
import com.roadguard.app.fragments.MapFragment
import com.roadguard.app.fragments.ProfileFragment
import com.roadguard.app.fragments.ReportsFragment
import com.roadguard.app.ui.Refreshable
import com.roadguard.app.ui.padForSystemBars
import kotlinx.coroutines.launch

class HomeActivity : AppCompatActivity() {

    private lateinit var binding: ActivityHomeBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityHomeBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.container.padForSystemBars(top = true)

        binding.bottomNav.setOnItemSelectedListener { item ->
            if (item.itemId == R.id.nav_drive) {
                startDrive()
                false // Drive opens full screen; keep the current tab selected.
            } else {
                show(item.itemId)
                true
            }
        }
        binding.bottomNav.setOnItemReselectedListener {
            (supportFragmentManager.findFragmentById(R.id.container) as? Refreshable)?.refresh()
        }

        if (savedInstanceState == null) show(R.id.nav_home)

        // Badge on Reports while sightings wait for network.
        val badge = binding.bottomNav.getOrCreateBadge(R.id.nav_reports).apply {
            backgroundColor = ContextCompat.getColor(this@HomeActivity, R.color.lane)
            badgeTextColor = ContextCompat.getColor(this@HomeActivity, R.color.lane_ink)
            isVisible = false
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                RoadGuardDatabase.get(this@HomeActivity).dao().observePendingCount().collect { n ->
                    badge.isVisible = n > 0
                    badge.number = n
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (!Session.canUseApp) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
        }
    }

    private fun show(itemId: Int) {
        val fragment: Fragment = when (itemId) {
            R.id.nav_map -> MapFragment()
            R.id.nav_reports -> ReportsFragment()
            R.id.nav_profile -> ProfileFragment()
            else -> HomeFragment()
        }
        supportFragmentManager.beginTransaction()
            .setReorderingAllowed(true)
            .replace(R.id.container, fragment)
            .commit()
    }

    /** Lets a screen switch tabs, e.g. Home's "Open map". */
    fun selectTab(itemId: Int) {
        binding.bottomNav.selectedItemId = itemId
    }

    fun startDrive() {
        startActivity(Intent(this, DriveActivity::class.java))
    }
}
