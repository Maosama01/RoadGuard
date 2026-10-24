package com.roadguard.app.fragments

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.roadguard.app.R
import com.roadguard.app.activities.LoginActivity
import com.roadguard.app.activities.SettingsActivity
import com.roadguard.app.data.Session
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.LeaderEntry
import com.roadguard.app.data.api.MyStats
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.databinding.FragmentProfileBinding
import com.roadguard.app.databinding.ItemLeaderBinding
import com.roadguard.app.ui.Refreshable
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.visible
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

class ProfileFragment : Fragment(), Refreshable {

    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.statReports.txtLabel.setText(R.string.profile_stat_reports)
        binding.statFound.txtLabel.setText(R.string.profile_stat_found)
        binding.statFixed.txtLabel.setText(R.string.profile_stat_fixed)
        binding.statStreak.txtLabel.setText(R.string.profile_stat_streak)
        binding.statKm.txtLabel.setText(R.string.profile_km_scanned)
        binding.statDrives.txtLabel.setText(R.string.profile_drives)

        binding.btnCreateAccount.setOnClickListener { startActivity(LoginActivity.upgradeIntent(requireContext())) }
        binding.rowSettings.setOnClickListener { startActivity(SettingsActivity.intent(requireContext())) }
        binding.rowSignOut.setOnClickListener { confirmSignOut() }
        binding.swipe.setColorSchemeResources(R.color.asphalt)
        binding.swipe.setOnRefreshListener { refresh() }

        showIdentity()
        refresh()
    }

    private fun showIdentity() {
        binding.txtAvatar.text = Ui.initials(Session.userName)
        binding.txtName.text = Session.userName.ifBlank { getString(R.string.profile_guest_name) }
        binding.txtAccount.text = if (Session.isGuest) getString(R.string.profile_account_guest) else Session.userEmail.orEmpty()
        binding.cardGuest.visible(Session.isGuest)
    }

    override fun refresh() {
        if (_binding == null) return
        binding.swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            coroutineScope {
                val me = async { apiCall { myStats() } }
                val board = async { apiCall { leaderboard(10) } }
                val m = me.await()
                val b = board.await()
                if (_binding == null) return@coroutineScope
                if (m is ApiResult.Ok) {
                    m.value.user?.let { Session.saveUser(it) }
                    showIdentity()
                    m.value.stats?.let { showStats(it) }
                } else if (m is ApiResult.Err) {
                    binding.txtNext.text = m.message + "\n" + getString(R.string.tap_to_retry)
                    binding.txtNext.setOnClickListener { refresh() }
                }
                if (b is ApiResult.Ok) showLeaders(b.value.items.orEmpty())
                binding.swipe.isRefreshing = false
            }
        }
    }

    private fun showStats(s: MyStats) {
        binding.txtNext.setOnClickListener(null) // it was a retry button after an error
        binding.txtLevel.text = s.level ?: getString(R.string.level_default)
        binding.txtPoints.text = resources.getQuantityString(R.plurals.profile_points, s.points, s.points)
        val next = s.nextLevelPoints
        if (next != null && next > s.levelFloorPoints) {
            val pct = ((s.points - s.levelFloorPoints) * 100 / (next - s.levelFloorPoints)).coerceIn(0, 100)
            binding.progressLevel.setProgressCompat(pct, true)
            val needed = next - s.points
            binding.txtNext.text = resources.getQuantityString(R.plurals.profile_points_to_next, needed, needed, s.nextLevel.orEmpty())
        } else {
            binding.progressLevel.setProgressCompat(100, true)
            binding.txtNext.setText(R.string.profile_top_level)
        }
        binding.txtRank.text = when {
            Session.isGuest -> getString(R.string.profile_rank_guest)
            s.points == 0 -> getString(R.string.profile_rank_none)
            else -> getString(R.string.profile_rank, s.rank)
        }
        binding.statReports.txtValue.text = s.reports.toString()
        binding.statFound.txtValue.text = s.hazardsDiscovered.toString()
        binding.statFixed.txtValue.text = s.hazardsFixed.toString()
        binding.statStreak.txtValue.text = s.streakDays.toString()
        binding.statKm.txtValue.text = if (s.kmScanned >= 100) {
            s.kmScanned.toInt().toString()
        } else Ui.oneDecimal(s.kmScanned)
        binding.statDrives.txtValue.text = s.drives.toString()
    }

    private fun showLeaders(items: List<LeaderEntry>) {
        val list = binding.leaderList
        list.removeAllViews()
        if (items.isEmpty()) {
            val row = ItemLeaderBinding.inflate(layoutInflater, list, false)
            row.txtLeaderName.setText(R.string.profile_nobody)
            row.txtLeaderMeta.setText(R.string.profile_be_first)
            list.addView(row.root)
            return
        }
        for (e in items) {
            val row = ItemLeaderBinding.inflate(layoutInflater, list, false)
            row.txtRank.text = e.rank.toString()
            row.txtLeaderName.text = if (e.isMe) getString(R.string.profile_leader_you, e.name) else e.name
            row.txtLeaderMeta.text = resources.getQuantityString(
                R.plurals.profile_leader_meta, e.reports, e.level ?: getString(R.string.level_default), e.reports
            )
            row.txtLeaderPoints.text = e.points.toString()
            if (e.isMe) row.txtRank.setTextColor(ContextCompat.getColor(requireContext(), R.color.ink))
            list.addView(row.root)
        }
    }

    private fun confirmSignOut() {
        com.roadguard.app.data.SignOut.confirm(requireActivity(), viewLifecycleOwner.lifecycleScope)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
