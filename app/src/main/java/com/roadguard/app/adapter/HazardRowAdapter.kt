package com.roadguard.app.adapter

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.roadguard.app.R
import com.roadguard.app.data.api.Hazard
import com.roadguard.app.databinding.ItemHazardRowBinding
import com.roadguard.app.ui.Ui

/** Compact hazard rows: severity edge, road, summary, distance. */
class HazardRowAdapter(
    private val onClick: (Hazard) -> Unit,
) : RecyclerView.Adapter<HazardRowAdapter.Holder>() {

    private var items: List<Hazard> = emptyList()

    fun submit(list: List<Hazard>) {
        items = list
        notifyDataSetChanged()
    }

    inner class Holder(val b: ItemHazardRowBinding) : RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        Holder(ItemHazardRowBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val h = items[position]
        val ctx = holder.b.root.context
        holder.b.edge.backgroundTintList = ColorStateList.valueOf(Ui.severityColor(ctx, h.severityLevel))
        holder.b.txtTitle.text = Ui.roadOrFallback(ctx, h.roadName)
        val summary = Ui.hazardSummary(ctx, h.type, h.severityLevel)
        holder.b.txtSubtitle.text = if (h.reportCount > 1) {
            ctx.getString(R.string.hazard_summary_with_drivers, summary, Ui.drivers(ctx, maxOf(h.uniqueReporters, 1)))
        } else summary
        holder.b.txtMeta.text = h.distanceMeters?.let { Ui.distance(ctx, it) } ?: ""
        holder.b.root.setOnClickListener { onClick(h) }
    }

    override fun getItemCount() = items.size
}
