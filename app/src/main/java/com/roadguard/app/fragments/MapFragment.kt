package com.roadguard.app.fragments

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.roadguard.app.R
import com.roadguard.app.activities.HazardDetailActivity
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.Hazard
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.databinding.FragmentMapBinding
import com.roadguard.app.location.LocationHelper
import com.roadguard.app.ui.Refreshable
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.visible
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.osmdroid.events.DelayedMapListener
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.events.MapListener
import org.osmdroid.events.ScrollEvent
import org.osmdroid.events.ZoomEvent
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.mylocation.GpsMyLocationProvider
import org.osmdroid.views.overlay.mylocation.MyLocationNewOverlay

/** Every reported hazard on an OpenStreetMap map, coloured by severity, sized by how many drivers hit it. */
class MapFragment : Fragment(), Refreshable {

    private var _binding: FragmentMapBinding? = null
    private val binding get() = _binding!!

    private var myLocation: MyLocationNewOverlay? = null
    private val markers = ArrayList<Marker>()
    private val iconCache = HashMap<String, BitmapDrawable>()
    private var loadJob: Job? = null
    private var selected: Hazard? = null

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.any { it }) {
            enableMyLocation()
            centerOnMe()
        } else if (!shouldShowRequestPermissionRationale(android.Manifest.permission.ACCESS_FINE_LOCATION)) {
            context?.let { com.roadguard.app.ui.Ui.openAppSettings(it) }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMapBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val map = binding.map
        map.setTileSource(TileSourceFactory.MAPNIK)
        map.setMultiTouchControls(true)
        map.zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
        map.setMinZoomLevel(4.0)
        map.controller.setZoom(14.5)
        map.controller.setCenter(GeoPoint(30.3165, 78.0322))

        LocationHelper.lastKnown(requireContext()) { loc ->
            if (_binding != null && loc != null) binding.map.controller.setCenter(GeoPoint(loc.latitude, loc.longitude))
        }
        if (LocationHelper.hasPermission(requireContext())) enableMyLocation()

        map.addMapListener(DelayedMapListener(object : MapListener {
            override fun onScroll(event: ScrollEvent?): Boolean {
                load()
                return false
            }

            override fun onZoom(event: ZoomEvent?): Boolean {
                load()
                return false
            }
        }, 450))

        binding.chipsStatus.setOnCheckedStateChangeListener { _, _ -> load() }
        binding.fabLocate.setOnClickListener {
            if (LocationHelper.hasPermission(requireContext())) centerOnMe()
            else locationPermission.launch(LocationHelper.PERMISSIONS)
        }
        binding.btnCardDetails.setOnClickListener {
            selected?.let { HazardDetailActivity.start(requireContext(), it.id) }
        }

        // Tapping empty map closes the hazard card (it used to stay until the next reload).
        // Index 0: markers are drawn above it and get their taps first.
        map.overlays.add(0, MapEventsOverlay(object : MapEventsReceiver {
            override fun singleTapConfirmedHelper(p: GeoPoint?): Boolean {
                _binding?.cardHazard?.visible(false)
                selected = null
                return false
            }

            override fun longPressHelper(p: GeoPoint?): Boolean = false
        }))

        // The first layout pass gives the map its real bounds.
        map.post { load() }
    }

    private fun enableMyLocation() {
        if (myLocation != null || _binding == null) return
        val overlay = MyLocationNewOverlay(GpsMyLocationProvider(requireContext()), binding.map)
        overlay.enableMyLocation()
        binding.map.overlays.add(overlay)
        myLocation = overlay
    }

    private fun centerOnMe() {
        val here = myLocation?.myLocation
        if (here != null) {
            binding.map.controller.animateTo(here)
            binding.map.controller.setZoom(16.0)
        } else {
            LocationHelper.lastKnown(requireContext()) { loc ->
                if (_binding == null) return@lastKnown
                if (loc != null) {
                    binding.map.controller.animateTo(GeoPoint(loc.latitude, loc.longitude))
                    binding.map.controller.setZoom(16.0)
                } else {
                    Toast.makeText(requireContext(), R.string.map_finding_location, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun refresh() = load()

    private fun statusFilter(): String = when (binding.chipsStatus.checkedChipId) {
        R.id.chipFixed -> "resolved"
        R.id.chipAll -> "all"
        else -> "open"
    }

    private fun load() {
        val b = _binding ?: return
        val box = b.map.boundingBox
        val query = mapOf(
            "status" to statusFilter(),
            "bbox" to "${box.lonWest},${box.latSouth},${box.lonEast},${box.latNorth}",
            "limit" to "400",
            "sort" to "severity",
        )
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            val r = apiCall { hazards(query) }
            val bb = _binding ?: return@launch
            when (r) {
                is ApiResult.Ok -> {
                    val items = r.value.items.orEmpty()
                    drawMarkers(items)
                    bb.txtCount.visible(true)
                    bb.txtCount.setOnClickListener(null)
                    bb.txtCount.isClickable = false
                    bb.txtCount.text = when {
                        items.isEmpty() -> getString(R.string.map_nothing)
                        r.value.total > items.size -> getString(R.string.map_showing_worst, items.size, r.value.total)
                        else -> resources.getQuantityString(R.plurals.map_in_view, items.size, items.size)
                    }
                }
                is ApiResult.Err -> {
                    bb.txtCount.visible(true)
                    // One tap retries; the pill says so.
                    bb.txtCount.text = if (r.offline) getString(R.string.map_offline) else r.message + "\n" + getString(R.string.tap_to_retry)
                    bb.txtCount.setOnClickListener { load() }
                }
            }
        }
    }

    private fun drawMarkers(items: List<Hazard>) {
        val map = binding.map
        map.overlays.removeAll(markers.toSet())
        markers.clear()
        // Draw worst last so it sits on top.
        for (h in items.sortedBy { it.severityScore }) {
            val m = Marker(map)
            m.position = GeoPoint(h.latitude, h.longitude)
            m.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            m.icon = iconFor(h)
            m.title = Ui.roadOrFallback(requireContext(), h.roadName)
            m.setInfoWindow(null as org.osmdroid.views.overlay.infowindow.MarkerInfoWindow?)
            m.setOnMarkerClickListener { _, _ ->
                select(h)
                true
            }
            markers.add(m)
        }
        map.overlays.addAll(markers)
        map.invalidate()
        selected?.let { sel -> if (items.none { it.id == sel.id }) binding.cardHazard.visible(false) }
    }

    private fun iconFor(h: Hazard): BitmapDrawable {
        val open = Ui.isOpen(h.status)
        val size = 14 + minOf(maxOf(h.uniqueReporters, 1), 10) * 1.4f
        val key = "${h.severityLevel}-$open-${size.toInt()}"
        iconCache[key]?.let { return it }

        val density = resources.displayMetrics.density
        val px = (size * density).toInt() + (6 * density).toInt()
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val center = px / 2f
        val radius = size * density / 2f
        val color = if (open) Ui.severityColor(requireContext(), h.severityLevel)
        else ContextCompat.getColor(requireContext(), R.color.done)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; alpha = if (open) 235 else 70 }
        val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2f * density
            this.color = if (open) 0xFFFFFFFF.toInt() else color
        }
        c.drawCircle(center, center, radius, fill)
        c.drawCircle(center, center, radius, ring)
        return BitmapDrawable(resources, bmp).also { iconCache[key] = it }
    }

    private fun select(h: Hazard) {
        selected = h
        binding.cardEdge.backgroundTintList = android.content.res.ColorStateList.valueOf(Ui.severityColor(requireContext(), h.severityLevel))
        val ctx = requireContext()
        binding.cardTitle.text = Ui.roadOrFallback(ctx, h.roadName)
        val summary = Ui.hazardSummary(ctx, h.type, h.severityLevel)
        val drivers = Ui.drivers(ctx, maxOf(h.uniqueReporters, 1))
        binding.cardSub.text = if (h.lastReportedAt > 0) {
            getString(R.string.map_card_sub_seen, summary, drivers, Ui.timeAgo(ctx, h.lastReportedAt))
        } else getString(R.string.map_card_sub, summary, drivers)
        Ui.styleStatusChip(binding.cardStatus, h.status)
        binding.cardHazard.visible(true)
        binding.map.controller.animateTo(GeoPoint(h.latitude, h.longitude))
    }

    override fun onResume() {
        super.onResume()
        _binding?.map?.onResume()
        myLocation?.enableMyLocation()
    }

    override fun onPause() {
        myLocation?.disableMyLocation()
        _binding?.map?.onPause()
        super.onPause()
    }

    override fun onDestroyView() {
        loadJob?.cancel()
        _binding?.map?.onDetach()
        myLocation = null
        markers.clear()
        super.onDestroyView()
        _binding = null
    }
}
