package com.roadguard.app.fragments

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import com.roadguard.app.R
import com.roadguard.app.activities.HazardDetailActivity
import com.roadguard.app.activities.HomeActivity
import com.roadguard.app.activities.LoginActivity
import com.roadguard.app.activities.SettingsActivity
import com.roadguard.app.adapter.HazardRowAdapter
import com.roadguard.app.data.Session
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.Hazard
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.databinding.FragmentHomeBinding
import com.roadguard.app.databinding.ItemStatBinding
import com.roadguard.app.location.LocationHelper
import com.roadguard.app.service.PocketScanService
import com.roadguard.app.ui.Refreshable
import com.roadguard.app.ui.ServerDialog
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.visible
import com.roadguard.app.utils.SeverityLevel
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

class HomeFragment : Fragment(), Refreshable {

    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!
    private val nearbyAdapter = HazardRowAdapter { HazardDetailActivity.start(requireContext(), it.id) }

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        loadNearby()
    }

    /** Location (precise + approximate together) and, on Android 13+, notifications for pocket mode. */
    private val pocketPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val ctx = context ?: return@registerForActivityResult
        if (LocationHelper.hasPrecise(ctx)) startPocket() else toast(R.string.pocket_needs_precise)
        loadNearby()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.txtGreeting.text = Ui.greeting(requireContext())
        showName()

        label(binding.statReports, R.string.home_stat_reports)
        label(binding.statFixed, R.string.home_stat_fixed)
        label(binding.statPoints, R.string.home_stat_points)
        label(binding.statCityOpen, R.string.home_stat_city_open)
        label(binding.statCityFixed, R.string.home_stat_city_fixed)
        label(binding.statCityToday, R.string.home_stat_city_today)
        binding.statPocketKm.txtLabel.setText(R.string.pocket_stat_km)
        binding.statPocketJolts.txtLabel.setText(R.string.pocket_stat_jolts)
        binding.statPocketKnown.txtLabel.setText(R.string.pocket_stat_known)

        binding.rvNearby.layoutManager = LinearLayoutManager(requireContext())
        binding.rvNearby.adapter = nearbyAdapter

        binding.btnStartDrive.setOnClickListener { (activity as? HomeActivity)?.startDrive() }
        binding.btnPocket.setOnClickListener {
            if (PocketScanService.isRunning) PocketScanService.stop(requireContext()) else requestPocket()
        }
        binding.btnOpenMap.setOnClickListener { (activity as? HomeActivity)?.selectTab(R.id.nav_map) }
        binding.btnSettings.setOnClickListener { startActivity(SettingsActivity.intent(requireContext())) }
        binding.btnRetry.setOnClickListener { refresh() }
        // The server address is a developer setting; drivers never need to see it.
        binding.btnServer.visible(com.roadguard.app.BuildConfig.DEBUG)
        binding.btnServer.setOnClickListener {
            (activity as? AppCompatActivity)?.let { host ->
                ServerDialog.show(host) {
                    // A registered account doesn't exist on the new server: sign in there.
                    if (!Session.canUseApp) {
                        startActivity(
                            android.content.Intent(host, LoginActivity::class.java)
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        )
                    } else refresh()
                }
            }
        }
        binding.btnAllowLocation.setOnClickListener {
            locationPermission.launch(LocationHelper.PERMISSIONS)
        }
        binding.txtGuestHint.setOnClickListener { startActivity(LoginActivity.upgradeIntent(requireContext())) }
        binding.swipe.setColorSchemeResources(R.color.asphalt)
        binding.swipe.setOnRefreshListener { refresh() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { PocketScanService.state.collect { showPocket(it) } }
                RoadGuardDatabase.get(requireContext()).dao().observePendingCount().collect { n ->
                    binding.txtPending.visible(n > 0)
                    binding.txtPending.text = resources.getQuantityString(R.plurals.home_pending, n, n)
                }
            }
        }

        refresh()
    }

    // ------------------------------------------------------------------ pocket mode

    private fun requestPocket() {
        val ctx = requireContext()
        val needed = mutableListOf<String>()
        if (!LocationHelper.hasPrecise(ctx)) needed += LocationHelper.PERMISSIONS
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.POST_NOTIFICATIONS
        if (needed.isEmpty()) startPocket() else pocketPermission.launch(needed.toTypedArray())
    }

    private fun startPocket() {
        val ctx = context ?: return
        // Without the notification permission it still runs; Android just hides the notification.
        if (!PocketScanService.start(ctx)) toast(R.string.pocket_could_not_start)
    }

    private fun showPocket(s: PocketScanService.State) {
        if (_binding == null) return
        binding.txtPocketOn.visible(s.running)
        binding.pocketStats.visible(s.running)
        binding.txtPocketBody.setText(if (s.running) R.string.pocket_running_body else R.string.pocket_body)
        binding.btnPocket.setText(if (s.running) R.string.pocket_stop_long else R.string.pocket_start)
        if (s.running) {
            binding.statPocketKm.txtValue.text = Ui.oneDecimal(s.meters / 1000)
            binding.statPocketJolts.txtValue.text = s.jolts.toString()
            binding.statPocketKnown.txtValue.text = s.knownHazards?.toString() ?: getString(R.string.no_value)
        }
    }

    private fun toast(res: Int) {
        val ctx = context ?: return
        Toast.makeText(ctx, res, Toast.LENGTH_LONG).show()
    }

    private fun showName() {
        val name = Ui.firstName(Session.userName)
        binding.txtName.text = name
        binding.txtName.visible(name.isNotBlank())
    }

    private fun label(stat: ItemStatBinding, @StringRes text: Int) {
        stat.txtLabel.setText(text)
    }

    override fun refresh() {
        if (_binding == null) return
        binding.swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            coroutineScope {
                val mine = async { apiCall { myStats() } }
                val city = async { apiCall { overview() } }
                val m = mine.await()
                val c = city.await()
                if (_binding == null) return@coroutineScope

                var error: String? = null
                // No connection is normal on the road: the card's own text explains it, no raw error.
                val offline = (m as? ApiResult.Err)?.offline == true || (c as? ApiResult.Err)?.offline == true
                when (m) {
                    is ApiResult.Ok -> {
                        val s = m.value.stats
                        m.value.user?.let { Session.saveUser(it) }
                        showName()
                        binding.statReports.txtValue.text = (s?.reports ?: 0).toString()
                        binding.statFixed.txtValue.text = (s?.hazardsFixed ?: 0).toString()
                        binding.statPoints.txtValue.text = (s?.points ?: 0).toString()
                        binding.txtLevel.text = s?.level ?: getString(R.string.level_default)
                        binding.txtLevel.visible(true)
                    }
                    is ApiResult.Err -> error = m.message
                }
                when (c) {
                    is ApiResult.Ok -> {
                        val t = c.value.totals
                        binding.statCityOpen.txtValue.text = (t?.open ?: 0).toString()
                        binding.statCityFixed.txtValue.text = getString(R.string.percent, t?.resolutionRate ?: 0)
                        binding.statCityToday.txtValue.text = (t?.reportsToday ?: 0).toString()
                    }
                    is ApiResult.Err -> error = error ?: c.message
                }
                binding.txtGuestHint.visible(Session.isGuest && m is ApiResult.Ok)
                binding.cardError.visible(error != null)
                binding.txtError.text = error.orEmpty()
                binding.txtError.visible(error != null && !offline)
            }
            loadNearby()
            _binding?.swipe?.isRefreshing = false
        }
    }

    private fun loadNearby() {
        if (_binding == null) return
        val ctx = context ?: return
        if (!LocationHelper.hasPermission(ctx)) {
            binding.txtNearCount.setText(R.string.no_value)
            binding.txtNearSub.setText(R.string.home_near_need_location)
            binding.btnAllowLocation.visible(true)
            nearbyAdapter.submit(emptyList())
            return
        }
        binding.btnAllowLocation.visible(false)
        LocationHelper.lastKnown(ctx) { loc ->
            if (_binding == null) return@lastKnown
            if (loc == null) {
                binding.txtNearSub.setText(R.string.home_near_waiting_fix)
                return@lastKnown
            }
            viewLifecycleOwner.lifecycleScope.launch {
                val r = apiCall { nearby(loc.latitude, loc.longitude, 2000) }
                if (_binding == null) return@launch
                when (r) {
                    is ApiResult.Ok -> showNearby(r.value.items.orEmpty())
                    is ApiResult.Err -> binding.txtNearSub.setText(R.string.home_near_error)
                }
            }
        }
    }

    private fun showNearby(items: List<Hazard>) {
        binding.txtNearCount.text = items.size.toString()
        val ctx = requireContext()
        binding.txtNearLabel.text = resources.getQuantityString(R.plurals.home_near_label, items.size)
        val worst = items.maxByOrNull { SeverityLevel.from(it.severityLevel).ordinal * 1000 + it.severityScore }
        binding.txtNearSub.text = when {
            items.isEmpty() -> getString(R.string.home_near_none)
            worst != null -> getString(
                R.string.home_near_worst,
                Ui.roadOrFallback(ctx, worst.roadName),
                Ui.severityWord(ctx, worst.severityLevel).lowercase(Ui.uiLocale(ctx)),
                worst.distanceMeters?.let { Ui.distance(ctx, it) } ?: "",
            )
            else -> ""
        }
        nearbyAdapter.submit(items.take(4))
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
