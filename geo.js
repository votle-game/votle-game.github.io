// Minimal TopoJSON -> SVG path decoder with an equirectangular projection.
// No external dependencies (d3/topojson not used) — keeps the bundle tiny.

const GeoEngine = (() => {

  // Decode topojson arcs (delta-encoded, quantized) into arrays of [lon, lat]
  function decodeArcs(topology) {
    const { scale, translate } = topology.transform;
    return topology.arcs.map(arc => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => {
        x += dx; y += dy;
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
      });
    });
  }

  // Project lon/lat -> SVG x/y. Equirectangular, viewBox 960x500.
  const WIDTH = 960, HEIGHT = 500;
  function project([lon, lat]) {
    const x = (lon + 180) * (WIDTH / 360);
    const y = (90 - lat) * (HEIGHT / 180);
    return [x, y];
  }

  // Build full coordinate rings for an arc index (handles negative = reversed shared arc)
  function arcCoords(decodedArcs, arcIndex) {
    if (arcIndex >= 0) {
      return decodedArcs[arcIndex];
    } else {
      const real = ~arcIndex;
      return decodedArcs[real].slice().reverse();
    }
  }

  function ringToPath(ring) {
    let d = '';
    ring.forEach((pt, i) => {
      const [x, y] = project(pt);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
    });
    d += 'Z';
    return d;
  }

  function geometryToPath(decodedArcs, geometry) {
    if (geometry.type === 'Polygon') {
      return geometry.arcs.map(ring => {
        let coords = [];
        ring.forEach(arcIdx => {
          const c = arcCoords(decodedArcs, arcIdx);
          coords = coords.concat(coords.length ? c.slice(1) : c);
        });
        return ringToPath(coords);
      }).join(' ');
    } else if (geometry.type === 'MultiPolygon') {
      return geometry.arcs.map(poly => {
        return poly.map(ring => {
          let coords = [];
          ring.forEach(arcIdx => {
            const c = arcCoords(decodedArcs, arcIdx);
            coords = coords.concat(coords.length ? c.slice(1) : c);
          });
          return ringToPath(coords);
        }).join(' ');
      }).join(' ');
    }
    return '';
  }

  // Compute centroid (approx, area-weighted for polygons via simple averaging of largest ring)
  function geometryCentroid(decodedArcs, geometry) {
    let polys;
    if (geometry.type === 'Polygon') polys = [geometry.arcs];
    else if (geometry.type === 'MultiPolygon') polys = geometry.arcs;
    else return null;

    // Find the ring with the largest bounding-box area (the "main" landmass)
    let best = null, bestArea = -1;
    polys.forEach(poly => {
      const ring = poly[0];
      let coords = [];
      ring.forEach(arcIdx => {
        const c = arcCoords(decodedArcs, arcIdx);
        coords = coords.concat(coords.length ? c.slice(1) : c);
      });
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      coords.forEach(([x,y]) => {
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      });
      const area = (maxX-minX)*(maxY-minY);
      if (area > bestArea) { bestArea = area; best = coords; }
    });
    if (!best) return null;
    let sx=0, sy=0;
    best.forEach(([x,y]) => { sx+=x; sy+=y; });
    const lon = sx/best.length, lat = sy/best.length;
    return project([lon, lat]);
  }

  function build(topology) {
    const decodedArcs = decodeArcs(topology);
    const geoms = topology.objects.countries.geometries;
    return geoms.map(g => ({
      id: g.id,
      name: g.properties && g.properties.name,
      path: geometryToPath(decodedArcs, g),
      centroid: geometryCentroid(decodedArcs, g),
    }));
  }

  return { build, project, WIDTH, HEIGHT };
})();
