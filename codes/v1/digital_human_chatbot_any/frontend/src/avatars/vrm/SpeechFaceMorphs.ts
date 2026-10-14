import * as THREE from 'three';
import { VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm';

/** Keep emotion deformation above the mouth; vowels own the lower face. */
export class SpeechFaceMorphs {
  private mouthTop = new Map<THREE.BufferGeometry, number>();
  private targets = new Map<THREE.BufferGeometry, Map<number, number>>();

  constructor(vrm: VRM) {
    for (const name of ['aa', 'ih', 'ee', 'oh', 'ou']) {
      for (const bind of vrm.expressionManager?.getExpression(name)?.binds ?? []) {
        if (!(bind instanceof VRMExpressionMorphTargetBind)) continue;
        for (const mesh of bind.primitives) {
          const geometry = mesh.geometry;
          const base = geometry.getAttribute('position');
          const morph = geometry.morphAttributes.position?.[bind.index];
          if (!base || !morph || bind.weight === 0) continue;
          for (let vertex = 0; vertex < base.count; vertex++) {
            const x = morph.getX(vertex) - (geometry.morphTargetsRelative ? 0 : base.getX(vertex));
            const y = morph.getY(vertex) - (geometry.morphTargetsRelative ? 0 : base.getY(vertex));
            const z = morph.getZ(vertex) - (geometry.morphTargetsRelative ? 0 : base.getZ(vertex));
            if (x * x + y * y + z * z <= 1e-12) continue;
            this.mouthTop.set(
              geometry,
              Math.max(this.mouthTop.get(geometry) ?? -Infinity, base.getY(vertex)),
            );
          }
        }
      }
    }
  }

  bind(source: VRMExpressionMorphTargetBind): VRMExpressionMorphTargetBind[] {
    return source.primitives.map((mesh) => {
      const geometry = mesh.geometry;
      const top = this.mouthTop.get(geometry);
      let index = source.index;
      if (top !== undefined) {
        let targets = this.targets.get(geometry);
        if (!targets) this.targets.set(geometry, (targets = new Map()));
        const cached = targets.get(source.index);
        if (cached !== undefined) index = cached;
        else {
          index = geometry.morphAttributes.position!.length;
          const position = geometry.getAttribute('position');
          for (const key of ['position', 'normal', 'color'] as const) {
            const morphs = geometry.morphAttributes[key];
            const morph = morphs?.[source.index];
            if (!morphs || !morph) continue;
            const base = geometry.getAttribute(key);
            const values = new Float32Array(morph.count * morph.itemSize);
            for (let vertex = 0; vertex < morph.count; vertex++) {
              const mouth = position.getY(vertex) <= top + 1e-4;
              for (let component = 0; component < morph.itemSize; component++)
                values[vertex * morph.itemSize + component] = mouth
                  ? geometry.morphTargetsRelative
                    ? 0
                    : base.getComponent(vertex, component)
                  : morph.getComponent(vertex, component);
            }
            const attribute = new THREE.Float32BufferAttribute(values, morph.itemSize);
            attribute.name = `speech-face-${source.index}`;
            morphs.push(attribute);
          }
          targets.set(source.index, index);
        }
        // All original indices remain valid; add weights for the speech variants.
        while (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length <= index)
          mesh.morphTargetInfluences.push(0);
      }
      return new VRMExpressionMorphTargetBind({ primitives: [mesh], index, weight: source.weight });
    });
  }
}
