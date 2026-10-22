package com.roadguard.app.adapter

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.ImageView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.resource.bitmap.CenterCrop
import com.bumptech.glide.load.resource.bitmap.RoundedCorners
import com.roadguard.app.R
import com.roadguard.app.data.api.ReportItem
import com.roadguard.app.database.PendingReport
import com.roadguard.app.databinding.ItemReportBinding
import com.roadguard.app.databinding.ItemSectionHeaderBinding
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.visible
import java.io.File

/** One list for reports still on the phone and reports the city already has. */
class ReportAdapter(
    private val onOpen: (ReportItem) -> Unit,
    private val onRetryRejected: () -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    sealed class Row {
        data class Header(val title: String, val action: String? = null) : Row()
        data class Pending(val report: PendingReport) : Row()
        data class Sent(val report: ReportItem) : Row()
    }

    private var rows: List<Row> = emptyList()

    fun submit(list: List<Row>) {
        rows = list
        notifyDataSetChanged()
    }

    class HeaderHolder(val b: ItemSectionHeaderBinding) : RecyclerView.ViewHolder(b.root)
    class ReportHolder(val b: ItemReportBinding) : RecyclerView.ViewHolder(b.root)

    override fun getItemViewType(position: Int) = if (rows[position] is Row.Header) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == 0) HeaderHolder(ItemSectionHeaderBinding.inflate(inflater, parent, false))
        else ReportHolder(ItemReportBinding.inflate(inflater, parent, false))
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = rows[position]) {
            is Row.Header -> bindHeader(holder as HeaderHolder, row)
            is Row.Pending -> bindPending(holder as ReportHolder, row.report)
            is Row.Sent -> bindSent(holder as ReportHolder, row.report)
        }
    }

    private fun bindHeader(h: HeaderHolder, row: Row.Header) {
        h.b.txtHeader.text = row.title
        h.b.btnHeaderAction.visible(row.action != null)
        h.b.btnHeaderAction.text = row.action
        h.b.btnHeaderAction.setOnClickListener { onRetryRejected() }
    }

    private fun bindPending(h: ReportHolder, r: PendingReport) {
        val ctx = h.b.root.context
        h.b.txtTitle.text = r.roadName?.takeIf { it.isNotBlank() } ?: ctx.getString(R.string.report_on_phone)
        h.b.txtSub.text = Ui.hazardSummary(ctx, r.type, r.severityLevel)
        h.b.sevBar.backgroundTintList = ColorStateList.valueOf(Ui.severityColor(ctx, r.severityLevel))
        if (r.state == PendingReport.STATE_REJECTED) {
            h.b.txtStatus.setText(R.string.report_not_accepted)
            Ui.tintChip(h.b.txtStatus, ContextCompat.getColor(ctx, R.color.sev_critical), ContextCompat.getColor(ctx, R.color.on_asphalt))
            h.b.txtMeta.text = r.lastError ?: Ui.timeAgo(ctx, r.timestamp)
        } else {
            h.b.txtStatus.setText(if (r.attempts == 0) R.string.report_sending_soon else R.string.report_waiting_network)
            Ui.tintChip(h.b.txtStatus, ContextCompat.getColor(ctx, R.color.lane), ContextCompat.getColor(ctx, R.color.lane_ink))
            h.b.txtMeta.text = Ui.timeAgo(ctx, r.timestamp)
        }
        loadThumb(h.b.imgThumb, r.imagePath?.let { File(it) })
        h.b.root.setOnClickListener(null)
        h.b.root.isClickable = false
    }

    private fun bindSent(h: ReportHolder, r: ReportItem) {
        val ctx = h.b.root.context
        h.b.txtTitle.text = Ui.roadOrFallback(ctx, r.roadName)
        h.b.txtSub.text = Ui.hazardSummary(ctx, r.type, r.severityLevel)
        h.b.sevBar.backgroundTintList = ColorStateList.valueOf(Ui.severityColor(ctx, r.severityLevel))
        Ui.styleStatusChip(h.b.txtStatus, r.hazardStatus)
        val others = (r.hazardReportCount ?: 1) - 1
        h.b.txtMeta.text = when {
            others > 0 -> ctx.resources.getQuantityString(R.plurals.report_seen_more, others, Ui.timeAgo(ctx, r.timestamp), others)
            else -> Ui.timeAgo(ctx, r.timestamp)
        }
        loadThumb(h.b.imgThumb, r.imageUrl)
        h.b.root.setOnClickListener { onOpen(r) }
    }

    private fun loadThumb(view: ImageView, source: Any?) {
        val radius = Ui.dp(view.context, 8)
        if (source == null || (source is File && !source.exists())) {
            Glide.with(view).clear(view)
            view.setImageResource(R.drawable.ic_map_outline)
            view.scaleType = ImageView.ScaleType.CENTER
            view.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(view.context, R.color.on_asphalt_muted))
            return
        }
        view.scaleType = ImageView.ScaleType.CENTER_CROP
        view.imageTintList = null
        Glide.with(view).load(source).transform(CenterCrop(), RoundedCorners(radius)).into(view)
    }

    override fun getItemCount() = rows.size
}
