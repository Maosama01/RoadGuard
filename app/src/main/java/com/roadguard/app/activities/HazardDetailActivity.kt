package com.roadguard.app.activities

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.bumptech.glide.Glide
import com.roadguard.app.R
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.Hazard
import com.roadguard.app.data.api.HazardDetailResponse
import com.roadguard.app.data.api.TimelineEvent
import com.roadguard.app.data.api.VoteRequest
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.databinding.ActivityHazardDetailBinding
import com.roadguard.app.databinding.ItemStageBinding
import com.roadguard.app.databinding.ItemTimelineBinding
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.padForSystemBars
import com.roadguard.app.ui.visible
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

class HazardDetailActivity : AppCompatActivity() {

    companion object {
        private const val EXTRA_ID = "hazard_id"

        fun start(context: Context, hazardId: Long) {
            context.startActivity(Intent(context, HazardDetailActivity::class.java).putExtra(EXTRA_ID, hazardId))
        }
    }

    private lateinit var binding: ActivityHazardDetailBinding
    private var hazard: Hazard? = null
    private val hazardId by lazy { intent.getLongExtra(EXTRA_ID, 0) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityHazardDetailBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.topBar.padForSystemBars(top = true)
        binding.scroll.padForSystemBars(top = false, bottom = true)

        binding.txtToolbarTitle.text = getString(R.string.detail_title, hazardId)
        binding.btnBack.setOnClickListener { finish() }
        binding.btnDirections.setOnClickListener { openInMaps() }
        binding.btnPresent.setOnClickListener { vote("present") }
        binding.btnFixed.setOnClickListener { vote("fixed") }
        binding.btnComplaint.setOnClickListener { sendComplaint() }
        binding.btnShareLink.setOnClickListener { shareLink() }
        binding.factDrivers.txtLabel.setText(R.string.detail_fact_drivers)
        binding.factSightings.txtLabel.setText(R.string.detail_fact_sightings)
        binding.factJolt.txtLabel.setText(R.string.detail_fact_jolt)

        load()
    }

    private fun load() {
        binding.progress.visible(true)
        lifecycleScope.launch {
            val r = apiCall { hazard(hazardId) }
            binding.progress.visible(false)
            when (r) {
                is ApiResult.Ok -> show(r.value)
                is ApiResult.Err -> {
                    binding.txtLoadError.text = r.message + "\n\n" + getString(R.string.tap_to_retry)
                    binding.txtLoadError.visible(true)
                    binding.txtLoadError.setOnClickListener {
                        binding.txtLoadError.visible(false)
                        load()
                    }
                }
            }
        }
    }

    private fun show(d: HazardDetailResponse) {
        val h = d.hazard ?: return
        hazard = h
        binding.scroll.visibility = android.view.View.VISIBLE
        val color = Ui.severityColor(this, h.severityLevel)

        // Photo: the hazard's best photo, else any sighting's.
        val photo = h.imageUrl ?: d.reports.orEmpty().firstOrNull { it.imageUrl != null }?.imageUrl
        binding.imgPhoto.visible(photo != null)
        binding.txtNoPhoto.visible(photo == null)
        if (photo != null) Glide.with(this).load(photo).centerCrop().into(binding.imgPhoto)

        binding.txtScore.text = h.severityScore.toInt().toString()
        binding.txtScore.setTextColor(color)
        binding.txtSeverityWord.text = getString(
            R.string.detail_severity_kind,
            Ui.severityWord(this, h.severityLevel),
            Ui.kindName(this, h.type).lowercase(Ui.uiLocale(this)),
        )
        binding.txtRoad.text = Ui.roadOrFallback(this, h.roadName)
        binding.txtSummary.text = getString(
            R.string.detail_summary, Ui.timeAgo(this, h.firstReportedAt), Ui.timeAgo(this, h.lastReportedAt)
        )

        showStages(h)
        showStatusNote(h)

        binding.factDrivers.txtValue.text = h.uniqueReporters.toString()
        binding.factSightings.txtValue.text = h.reportCount.toString()
        val end = h.resolvedAt ?: System.currentTimeMillis()
        val days = ((end - h.firstReportedAt) / DateUtils.DAY_IN_MILLIS).toInt()
        binding.factAge.txtValue.text = days.toString()
        binding.factAge.txtLabel.text = resources.getQuantityString(
            if (Ui.isOpen(h.status)) R.plurals.detail_days_waiting else R.plurals.detail_days_until_closed, days
        )
        binding.factJolt.txtValue.text = if (h.maxShock > 0) Ui.oneDecimal(h.maxShock.toDouble()) else getString(R.string.no_value)

        showVote(h)
        showAccountability(h, photo)
        showShareRow(h)
        showTimeline(d.timeline.orEmpty())
    }

    // ------------------------------------------------------------------ accountability

    private fun showAccountability(h: Hazard, beforePhoto: String?) {
        val c = h.contractor
        val s = h.segment
        val repair = h.repairImageUrl?.takeIf { it.isNotBlank() }
        val assigned = c != null || s != null
        binding.cardWho.visible(assigned || repair != null)
        if (!assigned && repair == null) return

        binding.txtContractor.visible(assigned)
        binding.txtContractor.text = c?.name?.takeIf { it.isNotBlank() } ?: getString(R.string.who_contractor_unknown)
        showContact(binding.txtContractorPhone, c?.phone)

        val tender = s?.tenderId?.takeIf { it.isNotBlank() }
        binding.txtTender.visible(tender != null)
        if (tender != null) binding.txtTender.text = getString(R.string.who_tender, tender)
        val ward = s?.ward?.takeIf { it.isNotBlank() }
        binding.txtWard.visible(ward != null)
        binding.txtWard.text = ward.orEmpty()
        val officer = s?.officerName?.takeIf { it.isNotBlank() }
        binding.txtOfficer.visible(officer != null)
        if (officer != null) binding.txtOfficer.text = getString(R.string.who_officer, officer)
        showContact(binding.txtOfficerContact, s?.officerContact)

        // Deadline: only while it is still waiting for the repair.
        val open = Ui.isOpen(h.status)
        val due = h.dueAt?.takeIf { it > 0 }
        val now = System.currentTimeMillis()
        val overdueDays = h.overdueDays
            ?: if (due != null && due < now) ((now - due) / DateUtils.DAY_IN_MILLIS).toInt() else 0
        binding.txtDue.visible(open && due != null)
        if (open && due != null) {
            if (overdueDays > 0) {
                binding.txtDue.text = resources.getQuantityString(R.plurals.who_overdue, overdueDays, overdueDays)
                binding.txtDue.setTextColor(ContextCompat.getColor(this, R.color.sev_critical))
            } else {
                binding.txtDue.text = getString(
                    R.string.who_due, DateFormat.getDateInstance(DateFormat.MEDIUM, Ui.uiLocale(this)).format(Date(due))
                )
                binding.txtDue.setTextColor(ContextCompat.getColor(this, R.color.ink))
            }
        }
        val level = (h.escalationLevel ?: 0).coerceIn(0, 3)
        binding.txtEscalation.visible(open && level > 0)
        if (open && level > 0) {
            binding.txtEscalation.text = getString(R.string.who_escalated, officer ?: getString(R.string.who_default_officer), level)
        }
        binding.txtWarranty.visible(h.underWarranty == true)

        binding.repairPhotos.visible(repair != null)
        if (repair != null) {
            Glide.with(this).load(repair).centerCrop().into(binding.imgAfter)
            binding.colBefore.visible(beforePhoto != null)
            if (beforePhoto != null) Glide.with(this).load(beforePhoto).centerCrop().into(binding.imgBefore)
        }
    }

    /** A phone number or email that opens the dialer or the mail app when tapped. */
    private fun showContact(view: android.widget.TextView, contact: String?) {
        val value = contact?.trim()?.takeIf { it.isNotEmpty() }
        view.visible(value != null)
        if (value == null) {
            view.setOnClickListener(null)
            return
        }
        view.text = value
        view.setOnClickListener { openContact(value) }
    }

    private fun openContact(contact: String) {
        val phone = Regex("\\+?[0-9][0-9 -]{5,}[0-9]").find(contact)?.value?.filter { it.isDigit() || it == '+' }
        val email = Regex("[^\\s,;<>/]+@[^\\s,;<>/]+").find(contact)?.value
        val intent = when {
            phone != null -> Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", phone, null))
            email != null -> Intent(Intent.ACTION_SENDTO, Uri.fromParts("mailto", email, null))
            else -> null
        }
        if (intent == null) {
            Toast.makeText(this, R.string.no_app_for_contact, Toast.LENGTH_SHORT).show()
            return
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_contact, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showShareRow(h: Hazard) {
        val canComplain = Ui.isOpen(h.status)
        val canShare = !h.publicUrl.isNullOrBlank()
        binding.rowShare.visible(canComplain || canShare)
        binding.btnComplaint.visible(canComplain)
        binding.btnShareLink.visible(canShare)
    }

    /** Fetches the ready-made formal complaint (in Hindi on a Hindi phone) and opens the share sheet. */
    private fun sendComplaint() {
        val h = hazard ?: return
        val lang = if (Ui.uiLocale(this).language == "hi") "hi" else "en"
        binding.btnComplaint.isEnabled = false
        lifecycleScope.launch {
            val r = apiCall { complaint(h.id, lang) }
            binding.btnComplaint.isEnabled = true
            when (r) {
                is ApiResult.Ok -> {
                    val c = r.value
                    val body = c.body?.takeIf { it.isNotBlank() } ?: c.publicUrl ?: h.publicUrl.orEmpty()
                    val send = Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, body)
                    c.subject?.takeIf { it.isNotBlank() }?.let { send.putExtra(Intent.EXTRA_SUBJECT, it) }
                    val email = c.to?.officerContact?.let { Regex("[^\\s,;<>/]+@[^\\s,;<>/]+").find(it)?.value }
                    if (email != null) send.putExtra(Intent.EXTRA_EMAIL, arrayOf(email))
                    openChooser(send, R.string.complaint_chooser)
                }
                is ApiResult.Err -> Toast.makeText(this@HazardDetailActivity, r.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun shareLink() {
        val h = hazard ?: return
        val url = h.publicUrl?.takeIf { it.isNotBlank() } ?: return
        val text = getString(R.string.share_link_text, Ui.kindName(this, h.type), Ui.roadOrFallback(this, h.roadName), url)
        openChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), R.string.share_chooser)
    }

    private fun openChooser(send: Intent, titleRes: Int) {
        try {
            startActivity(Intent.createChooser(send, getString(titleRes)))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_contact, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showStages(h: Hazard) {
        val stages = listOf(R.string.status_reported, R.string.status_verified, R.string.status_assigned, R.string.status_resolved)
        val reached = when (h.status) {
            "verified" -> 1
            "assigned", "in_progress" -> 2
            "resolved" -> 3
            else -> 0
        }
        binding.stages.removeAllViews()
        val ink = ContextCompat.getColor(this, R.color.brand_primary)
        val lane = ContextCompat.getColor(this, R.color.lane)
        val off = ContextCompat.getColor(this, R.color.line)
        val done = ContextCompat.getColor(this, R.color.sev_low)
        stages.forEachIndexed { i, name ->
            val s = ItemStageBinding.inflate(layoutInflater, binding.stages, false)
            s.txtStage.setText(if (i == 2 && h.status == "in_progress") R.string.status_in_progress else name)
            val barColor = when {
                h.status == "rejected" -> off
                h.status == "resolved" -> done
                i < reached -> ink
                i == reached -> lane
                else -> off
            }
            s.bar.backgroundTintList = ColorStateList.valueOf(barColor)
            s.txtStage.setTextColor(
                ContextCompat.getColor(this, if (i <= reached && h.status != "rejected") R.color.ink else R.color.muted)
            )
            (s.root.layoutParams as? LinearLayout.LayoutParams)?.weight = 1f
            binding.stages.addView(s.root)
        }
    }

    private fun showStatusNote(h: Hazard) {
        val note = when {
            h.status == "resolved" -> {
                val at = h.resolvedAt
                if (at != null) getString(R.string.detail_note_fixed_when, Ui.timeAgo(this, at))
                else getString(R.string.detail_note_fixed)
            }
            h.status == "rejected" -> getString(R.string.detail_note_rejected)
            h.status == "in_progress" -> h.assignedTeam?.let { getString(R.string.detail_note_in_progress_team, it) }
                ?: getString(R.string.detail_note_in_progress)
            h.status == "assigned" -> getString(R.string.detail_note_assigned, h.assignedTeam ?: getString(R.string.detail_default_crew))
            h.likelyFixed -> getString(R.string.detail_note_likely_fixed)
            h.reopenCount > 0 -> getString(R.string.detail_note_reopened)
            h.status == "verified" -> getString(R.string.detail_note_verified, Ui.drivers(this, h.uniqueReporters))
            else -> getString(R.string.detail_note_waiting)
        }
        binding.txtStatusNote.text = note
        binding.txtStatusNote.visible(true)
    }

    private fun showVote(h: Hazard) {
        val open = Ui.isOpen(h.status)
        binding.cardVote.visible(h.status != "rejected")
        binding.btnPresent.isEnabled = true
        binding.btnFixed.isEnabled = open
        val fixedVotes = h.votes?.get("fixed") ?: 0
        binding.txtVoteTitle.setText(if (open) R.string.vote_title_open else R.string.vote_title_closed)
        binding.txtVoteBody.text = when {
            !open -> getString(R.string.vote_body_closed)
            h.myVote == "fixed" -> if (fixedVotes >= 3) getString(R.string.vote_body_said_fixed) else {
                val more = 3 - fixedVotes
                resources.getQuantityString(R.plurals.vote_body_said_fixed_more, more, more)
            }
            h.myVote == "present" -> getString(R.string.vote_body_said_present)
            else -> getString(R.string.vote_body_default)
        }
        binding.btnPresent.setText(if (open) R.string.vote_still_there else R.string.vote_its_back)
    }

    private fun showTimeline(events: List<TimelineEvent>) {
        binding.timeline.removeAllViews()
        val list = events.reversed()
        list.forEachIndexed { i, e ->
            val row = ItemTimelineBinding.inflate(layoutInflater, binding.timeline, false)
            row.txtWhat.text = when (e.type) {
                "created" -> getString(R.string.timeline_created)
                "auto_verified" -> getString(R.string.timeline_auto_verified)
                "status_change" -> Ui.statusLabel(this, e.toStatus)
                "assigned" -> getString(R.string.timeline_assigned)
                "comment" -> getString(R.string.timeline_comment)
                "vote_fixed" -> getString(R.string.timeline_vote_fixed)
                "vote_present" -> getString(R.string.timeline_vote_present)
                "community_resolved" -> getString(R.string.timeline_community_resolved)
                "reopened" -> getString(R.string.timeline_reopened)
                "auto_assigned" -> getString(R.string.timeline_auto_assigned)
                "escalated" -> getString(R.string.timeline_escalated)
                "repaired" -> getString(R.string.timeline_repaired)
                else -> getString(R.string.timeline_update)
            }
            // The server names actors in English; translate the generic ones.
            val actor = when (e.actor) {
                null, "RoadGuard" -> getString(R.string.app_name)
                "A driver" -> getString(R.string.timeline_actor_driver)
                "City team" -> getString(R.string.timeline_actor_city)
                else -> e.actor
            }
            row.txtWhen.text = getString(R.string.timeline_when, Ui.timeAgo(this, e.createdAt), actor)
            row.txtNote.visible(!e.note.isNullOrBlank())
            row.txtNote.text = e.note
            row.line.visible(i < list.size - 1)
            if (i == 0) row.dot.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.lane))
            binding.timeline.addView(row.root)
        }
    }

    private fun vote(kind: String) {
        val h = hazard ?: return
        val reallyKind = if (kind == "present" || Ui.isOpen(h.status)) kind else "present"
        binding.btnFixed.isEnabled = false
        binding.btnPresent.isEnabled = false
        lifecycleScope.launch {
            when (val r = apiCall { vote(h.id, VoteRequest(reallyKind)) }) {
                is ApiResult.Ok -> {
                    val message = r.value.message ?: getString(R.string.vote_thanks)
                    val awarded = r.value.pointsAwarded
                    val text = if (awarded > 0) {
                        resources.getQuantityString(R.plurals.vote_thanks_points, awarded, message, awarded)
                    } else message
                    Toast.makeText(this@HazardDetailActivity, text, Toast.LENGTH_SHORT).show()
                    load()
                }
                is ApiResult.Err -> {
                    Toast.makeText(this@HazardDetailActivity, r.message, Toast.LENGTH_LONG).show()
                    showVote(h)
                }
            }
        }
    }

    private fun openInMaps() {
        val h = hazard ?: return
        val label = Uri.encode(Ui.kindName(this, h.type))
        val uri = Uri.parse("geo:${h.latitude},${h.longitude}?q=${h.latitude},${h.longitude}($label)")
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.detail_no_maps, Toast.LENGTH_SHORT).show()
        }
    }
}
