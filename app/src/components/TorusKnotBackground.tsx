"use client";

import { useEffect, useRef } from "react";

interface TorusKnotBackgroundProps {
  radius?: number;
  tube?: number;
  tubularSegments?: number;
  radialSegments?: number;
  p?: number;
  q?: number;
  opacity?: number;
  fogDensity?: number;
}

export default function TorusKnotBackground({
  radius = 8,
  tube = 0.4,
  tubularSegments = 200,
  radialSegments = 32,
  p = 2,
  q = 3,
  opacity = 0.2,
  fogDensity = 0.06,
}: TorusKnotBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;

    import("three").then((THREE) => {
      if (cancelled || !container.isConnected) return;

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x000000, fogDensity);

      const camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
      );
      camera.position.z = 12;

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      container.appendChild(renderer.domElement);

      const geometry = new THREE.TorusKnotGeometry(
        radius,
        tube,
        tubularSegments,
        radialSegments,
        p,
        q
      );
      const material = new THREE.MeshPhongMaterial({
        color: 0x2ee6a6,
        wireframe: true,
        transparent: true,
        opacity,
      });
      const torus = new THREE.Mesh(geometry, material);
      scene.add(torus);

      const light = new THREE.PointLight(0x2ee6a6, 1, 100);
      light.position.set(10, 10, 10);
      scene.add(light);

      let animationId: number;

      function animate() {
        animationId = requestAnimationFrame(animate);
        torus.rotation.x += 0.001;
        torus.rotation.y += 0.002;
        renderer.render(scene, camera);
      }
      animate();

      const handleResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
      window.addEventListener("resize", handleResize);

      cleanupRef.current = () => {
        cancelAnimationFrame(animationId);
        window.removeEventListener("resize", handleResize);
        renderer.dispose();
        geometry.dispose();
        material.dispose();
      };
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      container.innerHTML = "";
    };
  }, [radius, tube, tubularSegments, radialSegments, p, q, opacity, fogDensity]);

  return <div ref={containerRef} id="canvas-container" />;
}
