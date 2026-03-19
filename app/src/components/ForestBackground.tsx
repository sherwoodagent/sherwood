"use client";

import { useEffect, useRef } from "react";

export default function ForestBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    let cancelled = false;

    import("three").then((THREE) => {
      if (cancelled || !container.isConnected) return;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
      );
      camera.position.z = 2;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      container.appendChild(renderer.domElement);

      // Forest canopy shader plane
      const planeGeom = new THREE.PlaneGeometry(10, 10, 1, 1);

      const vertexShader = `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `;

      const fragmentShader = `
        uniform float uTime;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0, 0)), hash(i + vec2(1, 0)), f.x),
            mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
            f.y
          );
        }

        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p *= 2.0;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 sway = vec2(sin(uTime * 0.2), cos(uTime * 0.15)) * 0.05;
          float n = fbm(vUv * 4.0 + sway);

          vec3 col1 = vec3(0.01, 0.06, 0.04);
          vec3 col2 = vec3(0.08, 0.4, 0.28);
          vec3 col3 = vec3(0.18, 0.9, 0.65);

          vec3 finalCol = mix(col1, col2, n);
          finalCol = mix(finalCol, col3, pow(n, 3.0));

          gl_FragColor = vec4(finalCol, 1.0);
        }
      `;

      const planeMat = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uTime: { value: 0 } },
      });

      const backgroundPlane = new THREE.Mesh(planeGeom, planeMat);
      scene.add(backgroundPlane);

      // Falling leaf particles
      const leafCount = 400;
      const leafGeom = new THREE.BufferGeometry();
      const positions = new Float32Array(leafCount * 3);
      const velocities = new Float32Array(leafCount * 3);

      for (let i = 0; i < leafCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 5;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 5;
        positions[i * 3 + 2] = Math.random() * 0.5;
        velocities[i * 3] = (Math.random() - 0.5) * 0.002;
        velocities[i * 3 + 1] = -0.001 - Math.random() * 0.002;
      }

      leafGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const leafMat = new THREE.PointsMaterial({
        color: 0x2ee6a6,
        size: 0.012,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
      });

      const leafSystem = new THREE.Points(leafGeom, leafMat);
      scene.add(leafSystem);

      // Animation loop
      const clock = new THREE.Clock();
      let animationId: number;

      function animate() {
        animationId = requestAnimationFrame(animate);
        const time = clock.getElapsedTime();
        planeMat.uniforms.uTime.value = time;

        const pos = leafGeom.attributes.position.array as Float32Array;
        for (let i = 0; i < leafCount; i++) {
          pos[i * 3] += velocities[i * 3] + Math.sin(time + i) * 0.001;
          pos[i * 3 + 1] += velocities[i * 3 + 1];

          if (pos[i * 3 + 1] < -2.5) pos[i * 3 + 1] = 2.5;
          if (pos[i * 3] < -2.5) pos[i * 3] = 2.5;
          if (pos[i * 3] > 2.5) pos[i * 3] = -2.5;
        }
        leafGeom.attributes.position.needsUpdate = true;

        renderer.render(scene, camera);
      }
      animate();

      // Resize handler
      const handleResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
      window.addEventListener("resize", handleResize);

      // Store cleanup
      cleanupRef.current = () => {
        cancelAnimationFrame(animationId);
        window.removeEventListener("resize", handleResize);
        renderer.dispose();
        planeGeom.dispose();
        planeMat.dispose();
        leafGeom.dispose();
        leafMat.dispose();
      };
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      container.innerHTML = "";
    };
  }, []);

  return <div ref={containerRef} id="canvas-container" />;
}
