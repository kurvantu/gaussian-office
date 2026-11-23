import detailedUrl from '../../../data/humans/man-2-unrig.glb?url&no-inline';
import riggedUrl from '../../../data/humans/man-rig.glb?url&no-inline';
import animatedUrl from '../../../data/humans/Visitor.glb?url&no-inline';
import detailedPortrait from '../../assets/detailed-visitor.webp';
import riggedPortrait from '../../assets/rigged-visitor.webp';
import animatedPortrait from '../../assets/visitor-preview.webp';

export const library = {
  visitor: {
    title: 'Detailed visitor',
    actorId: 'visitor',
    file: 'man-2-unrig.glb',
    url: detailedUrl,
    idleClip: undefined,
    portrait: detailedPortrait,
    description: '1.86 m · Rest pose · No clips',
  },
  rigged: {
    title: 'Rigged visitor',
    actorId: 'rigged-visitor',
    file: 'man-rig.glb',
    url: riggedUrl,
    idleClip: undefined,
    portrait: riggedPortrait,
    description: '1.86 m · Authored idle, walk and greeting',
  },
  animated: {
    title: 'Animated visitor',
    actorId: 'visitor',
    file: 'Visitor.glb',
    url: animatedUrl,
    idleClip: 'Relaxed',
    portrait: animatedPortrait,
    description: '1.76 m · Embedded idle, walk and wave clips',
  },
} as const;
export type LibraryId = keyof typeof library;

export function isCliplessRiggedVisitor(file: string, clipCount: number) {
  return file === library.rigged.file && clipCount === 0;
}
