import detailedUrl from '../../../data/humans/man-2-unrig.glb?url&no-inline';
import animatedUrl from '../../../data/humans/Visitor.glb?url&no-inline';

// Each shelf entry describes the actual file inventory; the detailed export has a rig but no clips.
export const library = {
  visitor: { title: 'Detailed visitor', file: 'man-2-unrig.glb', url: detailedUrl, idleClip: undefined },
  animated: { title: 'Animated visitor', file: 'Visitor.glb', url: animatedUrl, idleClip: 'Relaxed' },
} as const;
export type LibraryId = keyof typeof library;
