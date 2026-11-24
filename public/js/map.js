// Choropleth world map (d3 + world-atlas). Pan with drag, zoom with wheel/pinch.

/* global d3, topojson */

const RAMP_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
// Dark mode: low values recede toward the dark surface, high values glow.
const RAMP_DARK = ['#104281', '#184f95', '#256abf', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];

export const isDark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

export function colorScale(max) {
  const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
  const interp = d3.interpolateRgbBasis(ramp);
  // Log scale so one country with 300 books doesn't wash out everything else.
  const s = d3.scaleLog().domain([1, Math.max(max, 2)]).range([0, 1]).clamp(true);
  return (v) => interp(s(v));
}

export class WorldMap {
  constructor(container, topology, { onHover, onSelect }) {
    this.container = container;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.features = topojson.feature(topology, topology.objects.countries).features.filter((f) => f.id);
    // Some ids appear twice (Australia & Ashmore and Cartier Is. share 036): keep the biggest shape's name.
    const byArea = [...this.features].sort((a, b) => d3.geoArea(a) - d3.geoArea(b));
    this.names = new Map(byArea.map((f) => [f.id, f.properties.name]));

    this.svg = d3.select(container).append('svg').attr('class', 'map-svg').attr('role', 'img');
    this.g = this.svg.append('g');
    this.sphere = this.g.append('path').attr('class', 'sphere');
    this.paths = this.g
      .selectAll('path.country')
      .data(this.features)
      .join('path')
      .attr('class', 'country')
      .on('pointerenter pointermove', (e, d) => this.onHover(d.id, e))
      .on('pointerleave', () => this.onHover(null))
      .on('click', (_, d) => this.onSelect(d.id));

    this.zoom = d3
      .zoom()
      .scaleExtent([1, 12])
      .on('zoom', (e) => {
        this.g.attr('transform', e.transform);
        this.g.style('--k', e.transform.k);
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);

    new ResizeObserver(() => this.layout()).observe(container);
    this.layout();
  }

  layout() {
    const w = this.container.clientWidth;
    const h = Math.max(260, Math.round(w * 0.5));
    this.svg.attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
    const projection = d3.geoEqualEarth().fitExtent([[8, 8], [w - 8, h - 8]], { type: 'Sphere' });
    const path = d3.geoPath(projection);
    this.sphere.datum({ type: 'Sphere' }).attr('d', path);
    this.paths.attr('d', path);
    this.zoom.translateExtent([[0, 0], [w, h]]).extent([[0, 0], [w, h]]);
  }

  update(counts, selected) {
    const max = d3.max(counts.values()) || 1;
    const color = colorScale(max);
    this.paths
      .style('fill', (d) => (counts.get(d.id) ? color(counts.get(d.id)) : null))
      .classed('has-data', (d) => counts.has(d.id))
      .classed('selected', (d) => d.id === selected);
    this.paths.filter((d) => d.id === selected).raise();
    return max;
  }

  resetZoom() {
    this.svg.transition().duration(400).call(this.zoom.transform, d3.zoomIdentity);
  }
}
