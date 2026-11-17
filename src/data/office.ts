import type { FloorplanData, Point2D } from '../types/floorplan';

// Approximate interior footprint traced from a waist-height slice of the aligned SOG.
// This is the navigation / triangle proxy, not a mesh reconstruction of the capture.
const footprint: Point2D[] = [
  { x: -9, z: -5 }, { x: 8, z: -5 }, { x: 8, z: 4.2 },
  { x: 1, z: 4.2 }, { x: 1, z: 0.4 }, { x: -9, z: 0.4 },
];

export const OFFICE: FloorplanData = {
  id: 'office',
  name: 'Office Dining Hall',
  subtitle: 'Office capture · SOG environment with a navigation plan',
  guideStart: { x: 2.3, z: 0.25 },
  guideStartYaw: 0.52,
  rooms: [{
    id: 'dining-hall', name: 'Dining Hall', polygon: footprint,
    floorMaterial: 'tile', labelOffset: { x: 4, z: 2 },
  }],
  walls: footprint.map((start, i) => ({
    id: `perimeter-${i}`, start, end: footprint[(i + 1) % footprint.length],
    height: 3, thickness: 0.16, isExterior: true,
  })),
  openings: [],
  furniture: [
    ...[[-6.6, -4], [-4.4, -4], [-2.1, -4], [1.6, -4], [3.9, -4], [6.2, -4],
      [-6.6, -1.65], [-4.4, -1.65], [-2.1, -1.65], [2.1, 3], [6.1, 3], [6.1, 0.9]]
      .map(([x, z], i) => ({
        id: `table-${i}`, type: 'dining_set' as const, label: 'Dining table',
        x, z, rotation: 0, width: 1.95, depth: 1.2,
      })),
    { id: 'island', type: 'kitchen_island', label: 'Service island', x: 4.05, z: -1.4, rotation: 0, width: 4.35, depth: 0.96 },
    { id: 'counter', type: 'kitchen_counter', label: 'Counter', x: 0, z: -2.4, rotation: 0, width: 0.72, depth: 1.85 },
  ],
  tourStops: [
    {
      id: 'office-aisle', roomName: 'Dining Hall', title: 'The dining aisle',
      description: 'Follow the aisle past the service island to see the rows of tables along the window wall.',
      highlights: ['Window seating', 'Service island'],
      guidePos: { x: 0.5, z: -0.6 }, featurePoint: { x: -4.4, z: -4 },
      cameraPos: { x: 3.8, y: 1.6, z: -0.35 }, cameraLookAt: { x: 0.4, y: 1.1, z: -0.85 },
    },
    {
      id: 'office-seating', roomName: 'Window Seating', title: 'Between the table rows',
      description: 'From this aisle you can look back across the dining hall, with tables on either side of the guide.',
      highlights: ['Dining tables', 'Cross-aisle view'],
      guidePos: { x: -4.4, z: -2.82 }, featurePoint: { x: -6.6, z: -4 },
      cameraPos: { x: -7.7, y: 1.6, z: -2.85 }, cameraLookAt: { x: -4.3, y: 1.1, z: -2.8 },
    },
  ],
};

// Frame the guide from inside the scan; its far-away reconstruction outliers do not
// make a useful orbit bounding box. Coordinates are in the same metres as the proxy.
export const OFFICE_VIEW = {
  position: { x: 4.25, y: 1.64, z: 3.65 },
  target: { x: 1.9, y: 1, z: 0 },
};
