package com.roadguard.app.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import com.roadguard.app.R
import com.roadguard.app.activities.HazardDetailActivity
import com.roadguard.app.activities.HomeActivity
import com.roadguard.app.adapter.ReportAdapter
import com.roadguard.app.data.ReportQueue
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.ReportItem
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.database.PendingReport
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.databinding.FragmentReportsBinding
import com.roadguard.app.ui.Refreshable
import com.roadguard.app.ui.visible
import kotlinx.coroutines.launch

class ReportsFragment : Fragment(), Refreshable {

    private var _binding: FragmentReportsBinding? = null
    private val binding get() = _binding!!

    private val adapter = ReportAdapter(
        onOpen = { HazardDetailActivity.start(requireContext(), it.hazardId) },
        onRetryRejected = { viewLifecycleOwner.lifecycleScope.launch { ReportQueue.retryRejected(requireContext()) } },
    )

    private var pending: List<PendingReport> = emptyList()
    private var sent: List<ReportItem> = emptyList()
    private var sentTotal = 0
    private var loadError: String? = null
    private var loadedOnce = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentReportsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.rvReports.layoutManager = LinearLayoutManager(requireContext())
        binding.rvReports.adapter = adapter
        binding.swipe.setColorSchemeResources(R.color.asphalt)
        binding.swipe.setOnRefreshListener { refresh() }
        binding.btnEmptyDrive.setOnClickListener { (activity as? HomeActivity)?.startDrive() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                RoadGuardDatabase.get(requireContext()).dao().observeAll().collect { list ->
                    val shrank = list.size < pending.size
                    pending = list
                    render()
                    // Something just uploaded: fetch it back with its server status.
                    if (shrank) refresh()
                }
            }
        }
        refresh()
    }

    override fun refresh() {
        if (_binding == null) return
        binding.swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val r = apiCall { myReports(limit = 100) }
            if (_binding == null) return@launch
            when (r) {
                is ApiResult.Ok -> {
                    sent = r.value.items.orEmpty()
                    sentTotal = r.value.total
                    loadError = null
                }
                is ApiResult.Err -> loadError = r.message
            }
            loadedOnce = true
            binding.swipe.isRefreshing = false
            render()
        }
    }

    private fun render() {
        if (_binding == null) return
        val rows = ArrayList<ReportAdapter.Row>()
        val waiting = pending.filter { it.state == PendingReport.STATE_PENDING }
        val rejected = pending.filter { it.state == PendingReport.STATE_REJECTED }

        if (waiting.isNotEmpty()) {
            rows += ReportAdapter.Row.Header(
                if (waiting.size == 1) getString(R.string.reports_waiting)
                else getString(R.string.reports_waiting_count, waiting.size)
            )
            waiting.forEach { rows += ReportAdapter.Row.Pending(it) }
        }
        if (rejected.isNotEmpty()) {
            rows += ReportAdapter.Row.Header(getString(R.string.reports_rejected), action = getString(R.string.action_try_again))
            rejected.forEach { rows += ReportAdapter.Row.Pending(it) }
        }
        if (sent.isNotEmpty()) {
            if (rows.isNotEmpty()) rows += ReportAdapter.Row.Header(getString(R.string.reports_sent))
            sent.forEach { rows += ReportAdapter.Row.Sent(it) }
        }
        adapter.submit(rows)

        val fixed = sent.count { it.hazardStatus == "resolved" }
        binding.txtSubtitle.text = when {
            loadError != null && sent.isEmpty() -> loadError
            sentTotal == 0 && pending.isEmpty() -> getString(R.string.reports_subtitle_empty)
            fixed > 0 -> getString(R.string.reports_subtitle_fixed, sentTotal, fixed)
            else -> getString(R.string.reports_subtitle_sent, sentTotal)
        }

        val empty = rows.isEmpty() && loadedOnce
        binding.emptyState.visible(empty)
        if (empty && loadError != null) {
            // Can't load: the button retries instead of starting a drive.
            binding.txtEmptyTitle.setText(R.string.reports_load_error)
            binding.txtEmptyBody.text = loadError
            binding.btnEmptyDrive.setText(R.string.action_try_again)
            binding.btnEmptyDrive.setOnClickListener { refresh() }
        } else {
            binding.txtEmptyTitle.setText(R.string.reports_empty_title)
            binding.txtEmptyBody.setText(R.string.reports_empty_body)
            binding.btnEmptyDrive.setText(R.string.action_start_drive)
            binding.btnEmptyDrive.setOnClickListener { (activity as? HomeActivity)?.startDrive() }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
