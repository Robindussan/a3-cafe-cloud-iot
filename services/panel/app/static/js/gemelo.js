// ============================================================================
// Gemelo digital en WebGL (Three.js) de una marquesina de secado de café.
// Estructura en alambrado: 8 m x 4 m, muros de 1,1 m y techo en arco de plástico,
// dos camas (zarandas) elevadas con el café pergamino, estufa de apoyo y el nodo sensor.
// Los datos en vivo cambian la escena:
//   temperatura -> color y velocidad del aire caliente que sube
//   humedad     -> color del café en las camas (azul húmedo -> crema seco)
//   luz (lux)   -> intensidad del sol y de sus rayos sobre el techo
//   CO          -> humo de la estufa (más denso y rojo al acercarse al umbral)
//   estado      -> color y pulso del nodo sensor
// ============================================================================
import * as THREE from "../vendor/three.module.min.js";
import { OrbitControls } from "../vendor/OrbitControls.js";

const LARGO = 8, ANCHO = 4, MURO = 1.1, FLECHA = 1.35;
const COL = { linea: 0xe0a96d, tenue: 0x6b5440, cama: 0x8cc084, sol: 0xf2c14e, nodo: 0x7fcf8b, mal: 0xef6a55 };
const mezclar = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, t)));

function lineas(puntos, color, opacidad = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(puntos);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacidad < 1, opacity: opacidad }));
}
function segmentos(pares, color, opacidad = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(pares.flat());
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacidad }));
}
const arco = (x, n = 28) => Array.from({ length: n + 1 }, (_, i) => {
  const a = Math.PI * i / n;
  return new THREE.Vector3(x, MURO + FLECHA * Math.sin(a), (ANCHO / 2) * Math.cos(a));
});
const alturaTecho = z => MURO + FLECHA * Math.sqrt(Math.max(0, 1 - (2 * z / ANCHO) ** 2));

function construirMarquesina(escena) {
  const g = new THREE.Group();
  // Cimiento y piso
  const p = (x, y, z) => new THREE.Vector3(x, y, z);
  const L = LARGO / 2, A = ANCHO / 2;
  g.add(lineas([p(-L, 0, -A), p(L, 0, -A), p(L, 0, A), p(-L, 0, A), p(-L, 0, -A)], COL.linea));
  // Costillas del arco con sus parales
  for (let x = -L; x <= L + 1e-6; x += 1) {
    const extremo = Math.abs(x) > L - 0.01;
    g.add(lineas(arco(x), COL.linea, extremo ? 1 : 0.8));
    g.add(segmentos([[p(x, 0, -A), p(x, MURO, -A)], [p(x, 0, A), p(x, MURO, A)]], COL.linea, 0.9));
  }
  // Correas longitudinales sobre el arco y viga de muro
  [0, 0.18, 0.34, 0.5, 0.66, 0.82, 1].forEach(f => {
    const a = Math.PI * f, y = MURO + FLECHA * Math.sin(a), z = A * Math.cos(a);
    g.add(lineas([p(-L, y, z), p(L, y, z)], COL.linea, f === 0.5 ? 0.95 : 0.55));
  });
  g.add(lineas([p(-L, 0.35, -A), p(L, 0.35, -A)], COL.tenue, 0.6));
  g.add(lineas([p(-L, 0.35, A), p(L, 0.35, A)], COL.tenue, 0.6));
  // Muros frontales: parales hasta el arco y puerta en el frente +x
  [-1.4, -0.7, 0.7, 1.4].forEach(z => {
    g.add(lineas([p(-L, 0, z), p(-L, alturaTecho(z), z)], COL.tenue, 0.7));
    if (Math.abs(z) > 0.6) g.add(lineas([p(L, 0, z), p(L, alturaTecho(z), z)], COL.tenue, 0.7));
  });
  g.add(lineas([p(L, 0, -0.55), p(L, 1.95, -0.55), p(L, 1.95, 0.55), p(L, 0, 0.55)], COL.linea));
  // Cubierta de plástico (superficie casi transparente para dar volumen)
  // Medio cilindro (x = sen θ ≥ 0) acostado sobre el eje x: queda como bóveda sobre los muros
  const forma = new THREE.CylinderGeometry(1, 1, LARGO, 48, 1, true, 0, Math.PI);
  forma.rotateZ(Math.PI / 2);
  const cubierta = new THREE.Mesh(forma, new THREE.MeshBasicMaterial({ color: 0xe0a96d, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false }));
  cubierta.scale.set(1, FLECHA, A);
  cubierta.position.y = MURO;
  g.add(cubierta);
  escena.add(g);
}

// Camas elevadas (zarandas) con el café: puntos con altura irregular, coloreados por humedad.
function construirCamas(escena) {
  const g = new THREE.Group();
  const L = 3.6, ALTO = 0.8, camas = [[-1.75, -0.45], [0.45, 1.75]];
  const posiciones = [];
  camas.forEach(([z0, z1]) => {
    const caja = new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * L, 0.08, z1 - z0));
    const marco = new THREE.LineSegments(caja, new THREE.LineBasicMaterial({ color: COL.cama, transparent: true, opacity: 0.9 }));
    marco.position.set(0, ALTO, (z0 + z1) / 2);
    g.add(marco);
    for (let x = -L; x <= L + 1e-6; x += 1.2) {
      [z0, z1].forEach(z => g.add(lineas([new THREE.Vector3(x, 0, z), new THREE.Vector3(x, ALTO, z)], COL.cama, 0.45)));
    }
    for (let x = -L + 0.04; x < L; x += 0.055) {
      for (let z = z0 + 0.04; z < z1 - 0.02; z += 0.055) {
        const pila = 0.015 + 0.035 * Math.sin(x * 2.1) * Math.sin(z * 3.3) ** 2 + Math.random() * 0.01;
        posiciones.push(x + (Math.random() - 0.5) * 0.02, ALTO + 0.045 + pila, z + (Math.random() - 0.5) * 0.02);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(posiciones, 3));
  const cafe = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.028, color: 0xd9b38c, transparent: true, opacity: 0.95 }));
  g.add(cafe);
  escena.add(g);
  return cafe;
}

// Partículas genéricas que suben desde una región (aire caliente o humo).
function nube(escena, n, region, tam, color) {
  const pos = new Float32Array(n * 3), vel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = region.x0 + Math.random() * (region.x1 - region.x0);
    pos[i * 3 + 1] = region.y0 + Math.random() * (region.y1 - region.y0);
    pos[i * 3 + 2] = region.z0 + Math.random() * (region.z1 - region.z0);
    vel[i] = 0.4 + Math.random() * 0.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: tam, color, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
  const puntos = new THREE.Points(geo, mat);
  escena.add(puntos);
  return { puntos, pos, vel, n, region };
}

function moverNube(c, dt, velocidad, deriva = 0) {
  const { pos, vel, n, region: r } = c;
  for (let i = 0; i < n; i++) {
    pos[i * 3 + 1] += vel[i] * velocidad * dt;
    pos[i * 3] += deriva * dt * (Math.sin(pos[i * 3 + 1] * 3 + i) * 0.5);
    const techo = r.limiteTecho ? alturaTecho(pos[i * 3 + 2]) - 0.05 : r.y1;
    if (pos[i * 3 + 1] > techo) {
      pos[i * 3] = r.x0 + Math.random() * (r.x1 - r.x0);
      pos[i * 3 + 1] = r.y0;
      pos[i * 3 + 2] = r.z0 + Math.random() * (r.z1 - r.z0);
    }
  }
  c.puntos.geometry.attributes.position.needsUpdate = true;
}

function construirSol(escena) {
  const g = new THREE.Group();
  const esfera = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.55, 1)),
    new THREE.LineBasicMaterial({ color: COL.sol, transparent: true, opacity: 0.9 }));
  g.add(esfera);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16),
    new THREE.MeshBasicMaterial({ color: COL.sol, transparent: true, opacity: 0.08, depthWrite: false }));
  g.add(halo);
  g.position.set(-5.5, 6.2, -4.5);
  escena.add(g);
  // Rayos del sol hacia el techo
  const pares = [];
  for (let x = -3.5; x <= 3.5; x += 1.75) for (const f of [0.25, 0.5, 0.75]) {
    const a = Math.PI * f;
    pares.push([g.position.clone(), new THREE.Vector3(x, MURO + FLECHA * Math.sin(a), (ANCHO / 2) * Math.cos(a))]);
  }
  const rayos = segmentos(pares, COL.sol, 0.15);
  escena.add(rayos);
  return { g, esfera, halo, rayos };
}

function construirNodo(escena) {
  const g = new THREE.Group();
  g.add(lineas([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.55, 0)], COL.tenue, 0.9));
  const caja = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.22, 0.14, 0.12)),
    new THREE.LineBasicMaterial({ color: COL.nodo }));
  caja.position.y = 1.62;
  g.add(caja);
  const anillo = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.23, 40),
    new THREE.MeshBasicMaterial({ color: COL.nodo, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  anillo.position.y = 1.62;
  anillo.rotation.x = -Math.PI / 2;
  g.add(anillo);
  escena.add(g);
  return { caja, anillo };
}

function construirEstufa(escena) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, 0.45, 0.5)),
    new THREE.LineBasicMaterial({ color: 0xb87a55 }));
  e.position.set(-3.65, 0.225, 0);
  escena.add(e);
  escena.add(lineas([new THREE.Vector3(-3.65, 0.45, 0), new THREE.Vector3(-3.65, 1.2, 0)], 0xb87a55, 0.8));
}

export function crearGemelo(contenedor) {
  const escena = new THREE.Scene();
  escena.fog = new THREE.Fog(0x0b0907, 14, 30);
  const camara = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camara.position.set(7.5, 5.2, 8.5);
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  render.setPixelRatio(Math.min(2, window.devicePixelRatio));
  contenedor.appendChild(render.domElement);
  const controles = new OrbitControls(camara, render.domElement);
  controles.target.set(0, 1, 0);
  controles.enableDamping = true;
  controles.minDistance = 4;
  controles.maxDistance = 22;
  controles.maxPolarAngle = Math.PI * 0.49;
  const movimientoReducido = matchMedia("(prefers-reduced-motion: reduce)").matches;
  controles.autoRotate = !movimientoReducido;
  controles.autoRotateSpeed = 0.35;
  // La rueda solo acerca después de hacer clic en el gemelo; así no "atrapa" el scroll de la página.
  controles.enableZoom = false;
  render.domElement.addEventListener("pointerdown", () => { controles.enableZoom = true; controles.autoRotate = false; });
  render.domElement.addEventListener("pointerleave", () => { controles.enableZoom = false; });

  const rejilla = new THREE.GridHelper(26, 26, 0x3a2d22, 0x1f1812);
  rejilla.position.y = -0.001;
  escena.add(rejilla);
  construirMarquesina(escena);
  const cafe = construirCamas(escena);
  const aire = nube(escena, 420, { x0: -3.7, x1: 3.7, y0: 0.9, y1: 2.4, z0: -1.8, z1: 1.8, limiteTecho: true }, 0.05, 0xf2c14e);
  const humo = nube(escena, 160, { x0: -3.8, x1: -3.5, y0: 1.2, y1: 2.6, z0: -0.15, z1: 0.15, limiteTecho: true }, 0.07, 0xef6a55);
  const sol = construirSol(escena);
  const nodo = construirNodo(escena);
  construirEstufa(escena);

  // Etiquetas HTML que siguen puntos de la escena
  const etiquetas = {};
  const anclas = { temp: new THREE.Vector3(0.8, 2.2, 0), hr: new THREE.Vector3(2.4, 0.9, 1.1), lux: sol.g.position, co: new THREE.Vector3(-3.65, 1.4, 0), nodo: new THREE.Vector3(0, 1.85, 0) };
  for (const k of Object.keys(anclas)) {
    const el = document.createElement("div");
    el.className = "etiqueta3d";
    contenedor.appendChild(el);
    etiquetas[k] = el;
  }

  // Estado visual que se interpola hacia los valores reales
  const meta = { calor: 0.3, humedad: 0.5, luz: 0.2, co: 0, online: true };
  const actual = { ...meta };

  function ajustar() {
    const { clientWidth: w, clientHeight: h } = contenedor;
    render.setSize(w, h, false);
    camara.aspect = w / Math.max(1, h);
    camara.updateProjectionMatrix();
  }
  new ResizeObserver(ajustar).observe(contenedor);
  ajustar();

  const reloj = new THREE.Clock();
  const v = new THREE.Vector3();
  function cuadro() {
    const dt = Math.min(0.05, reloj.getDelta()), t = reloj.elapsedTime;
    for (const k of ["calor", "humedad", "luz", "co"]) actual[k] += (meta[k] - actual[k]) * Math.min(1, dt * 2);
    // Aire caliente: azul (fresco) -> ámbar (secado ideal) -> rojo (sobresecado)
    aire.puntos.material.color.copy(actual.calor < 0.5 ? mezclar(0x6fb3dc, 0xf2c14e, actual.calor * 2) : mezclar(0xf2c14e, 0xef6a55, (actual.calor - 0.5) * 2));
    aire.puntos.material.opacity = 0.25 + 0.5 * actual.calor;
    moverNube(aire, dt, 0.25 + 1.2 * actual.calor, 0.3);
    // Café: azul grisáceo (húmedo) -> crema (seco)
    cafe.material.color.copy(mezclar(0xd9b38c, 0x7fa9c9, actual.humedad));
    // Sol y rayos según la luz
    sol.esfera.material.opacity = 0.25 + 0.75 * actual.luz;
    sol.halo.material.opacity = 0.03 + 0.18 * actual.luz;
    sol.halo.scale.setScalar(1 + 0.08 * Math.sin(t * 2) * actual.luz);
    sol.rayos.material.opacity = 0.03 + 0.3 * actual.luz;
    sol.esfera.rotation.y += dt * 0.2;
    // Humo de la estufa según CO
    humo.puntos.material.opacity = 0.05 + 0.7 * actual.co;
    humo.puntos.material.color.copy(mezclar(0x8a7a6a, 0xef6a55, actual.co));
    moverNube(humo, dt, 0.3 + 0.8 * actual.co, 0.6);
    // Nodo sensor: pulso verde en línea, rojo desconectado
    const c = meta.online ? COL.nodo : COL.mal;
    nodo.caja.material.color.setHex(c);
    nodo.anillo.material.color.setHex(c);
    const pulso = (t * 0.8) % 1;
    nodo.anillo.scale.setScalar(1 + pulso * 2.2);
    nodo.anillo.material.opacity = meta.online ? 0.8 * (1 - pulso) : 0.5;

    controles.update();
    render.render(escena, camara);
    const { clientWidth: w, clientHeight: h } = contenedor;
    for (const [k, el] of Object.entries(etiquetas)) {
      v.copy(anclas[k]).project(camara);
      const visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      el.style.display = visible && el.textContent ? "block" : "none";
      el.style.left = ((v.x + 1) / 2) * w + "px";
      el.style.top = ((1 - v.y) / 2) * h - 6 + "px";
    }
    requestAnimationFrame(cuadro);
  }
  requestAnimationFrame(cuadro);

  const f = (x, d = 1) => x == null ? "–" : Number(x).toLocaleString("es-CO", { maximumFractionDigits: d, minimumFractionDigits: d });
  return {
    actualizar(m, umbrales) {
      const enLinea = m.estado === "online" && m.ultimo_dato && (Date.now() - new Date(m.ultimo_dato)) < 12 * 60000;
      meta.online = !!enLinea;
      if (m.temp != null) meta.calor = Math.min(1, Math.max(0, (m.temp - 15) / ((umbrales.temp_max || 50) + 5 - 15)));
      if (m.hr != null) meta.humedad = Math.min(1, Math.max(0, (m.hr - 30) / 60));
      if (m.lux != null) meta.luz = Math.min(1, Math.log10(1 + m.lux) / 5);
      if (m.co != null) meta.co = Math.min(1, m.co / (umbrales.co_max || 35));
      etiquetas.temp.innerHTML = `Aire ${f(m.temp)} °C`;
      etiquetas.hr.innerHTML = `Café · HR ${f(m.hr)} %`;
      etiquetas.lux.innerHTML = `Sol ${m.lux == null ? "–" : m.lux < 1000 ? Math.round(m.lux) + " lx" : f(m.lux / 1000) + " klx"}`;
      etiquetas.co.innerHTML = `Estufa · CO ${f(m.co)} ppm`;
      etiquetas.nodo.innerHTML = `Nodo ${m.id.slice(-2)} <small>${enLinea ? "en línea" : "sin conexión"}</small>`;
    },
  };
}
