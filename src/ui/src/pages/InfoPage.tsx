import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

/* ─── WebGL circuit-board animation ──────────────────────────────────────── */
function useCircuitCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl");
    if (!gl) return;

    let animId: number;

    function resize() {
      if (!canvas || !gl) return;
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener("resize", resize);

    /* ── vertex shader — full-screen quad ── */
    const vsSource = `
      attribute vec2 a_pos;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    /* ── fragment shader: circuit-board / techno style ── */
    const fsSource = `
      precision mediump float;
      uniform float u_time;
      uniform vec2  u_res;

      float hash(float n) { return fract(sin(n) * 43758.5453); }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        // aspect-correct space in [-1,1]
        vec2 p = (uv * 2.0 - 1.0) * vec2(u_res.x / u_res.y, 1.0);

        vec3 bg = vec3(0.047, 0.055, 0.071);   // #0c0e12
        vec3 col = bg;

        // ── grid constants ──────────────────────────────────────────────
        float COLS = 10.0;
        float ROWS = 6.0;
        float cellW = 2.0 * (u_res.x / u_res.y) / COLS;
        float cellH = 2.0 / ROWS;

        // ── per-cell UV (grid coords) ───────────────────────────────────
        vec2 gridUV = (p + vec2(u_res.x / u_res.y, 1.0)) / vec2(cellW, cellH);
        vec2 cellID = floor(gridUV);
        vec2 cellFrac = fract(gridUV);       // 0..1 within a cell

        // node centre = (0.5, 0.5) in cell-frac space
        // We draw nodes at cell corners by checking 4 corners per pixel.

        float bright = 0.0;

        // ── horizontal trace lines ──────────────────────────────────────
        // For every row, draw a horizontal line at cellFrac.y == 0 (cell border)
        {
          float lineY = min(cellFrac.y, 1.0 - cellFrac.y);  // dist to nearest h-edge
          float lineW = 0.018 / cellH;
          if (lineY < lineW) {
            float mask = step(lineY / lineW, 1.0);
            // alternating rows have traces on odd/even cells
            float rowHash = hash(cellID.y * 7.3 + 1.1);
            float colHash = hash(cellID.x * 3.7 + cellID.y * 11.1);
            // only draw trace if this cell "connects" horizontally
            if (colHash > 0.35) {
              // data packet travelling along trace
              float packetSpeed = 0.4 + rowHash * 0.6;
              float packetPhase = hash(cellID.y * 5.1 + cellID.x * 2.3);
              float packetPos = fract(u_time * packetSpeed + packetPhase);
              float packetX = abs(cellFrac.x - packetPos);
              float packet = step(packetX, 0.04) * 3.0;

              vec3 traceCol = mix(
                vec3(0.0, 0.9, 0.55),   // electric green
                vec3(0.0, 0.75, 1.0),   // cyan
                rowHash
              );
              col += traceCol * mask * (0.12 + packet * 0.5);
              bright += mask * (0.08 + packet * 0.35);
            }
          }
        }

        // ── vertical trace lines ───────────────────────────────────────
        {
          float lineX = min(cellFrac.x, 1.0 - cellFrac.x);
          float lineW = 0.018 / cellW;
          if (lineX < lineW) {
            float colHash2 = hash(cellID.x * 5.9 + 2.2);
            float rowHash2 = hash(cellID.y * 3.1 + cellID.x * 9.7);
            if (rowHash2 > 0.45) {
              float packetSpeed2 = 0.3 + colHash2 * 0.5;
              float packetPhase2 = hash(cellID.x * 6.3 + cellID.y * 1.7);
              float packetPos2 = fract(u_time * packetSpeed2 + packetPhase2);
              float packetY = abs(cellFrac.y - packetPos2);
              float packet2 = step(packetY, 0.05) * 3.0;

              vec3 traceCol2 = mix(
                vec3(0.0, 0.75, 1.0),
                vec3(0.55, 0.2, 1.0),   // violet accent
                colHash2
              );
              col += traceCol2 * (0.10 + packet2 * 0.45);
              bright += 0.06 + packet2 * 0.30;
            }
          }
        }

        // ── 45° diagonal traces (bottom-left → top-right) ─────────────
        {
          // signed distance to the diagonal line y = x in cell-frac space
          // scale coords to be square in screen space
          float fx = cellFrac.x * cellW;
          float fy = cellFrac.y * cellH;
          float diagLen = sqrt(cellW * cellW + cellH * cellH);
          // perpendicular distance to y==x diagonal
          float diagDist = abs(fy - fx) / sqrt(2.0);
          float lineW45 = 0.013;  // ~same visual weight as h/v traces
          if (diagDist < lineW45) {
            float dh = hash(cellID.x * 4.1 + cellID.y * 13.7 + 5.5);
            float dh2 = hash(cellID.x * 8.3 + cellID.y * 2.9 + 1.2);
            // only ~30% of cells get a 45° trace
            if (dh > 0.70) {
              float mask45 = 1.0 - diagDist / lineW45;
              // parametric position along diagonal: t goes 0→1 bottom-left to top-right
              float t45 = (cellFrac.x + cellFrac.y) * 0.5;
              float packetSpeed45 = 0.35 + dh * 0.55;
              float packetPhase45 = hash(cellID.x * 5.5 + cellID.y * 3.3 + 7.1);
              float packetPos45 = fract(u_time * packetSpeed45 + packetPhase45);
              float packet45 = step(abs(t45 - packetPos45), 0.045) * 3.0;

              vec3 traceCol45 = mix(
                vec3(1.0, 0.55, 0.05),  // amber
                vec3(0.0, 0.90, 0.55),  // green
                dh2
              );
              col += traceCol45 * mask45 * (0.11 + packet45 * 0.50);
              bright += mask45 * (0.07 + packet45 * 0.32);
            }
          }
        }

        // ── 135° diagonal traces (bottom-right → top-left) ────────────
        {
          float fx2 = cellFrac.x * cellW;
          float fy2 = cellFrac.y * cellH;
          // perpendicular distance to y == (cellH - cellW*x/cellW) → y = cellH - x scaled
          float diagDist2 = abs(fy2 - (cellH - fx2)) / sqrt(2.0);
          float lineW135 = 0.013;
          if (diagDist2 < lineW135) {
            float dh3 = hash(cellID.x * 6.7 + cellID.y * 11.1 + 9.9);
            float dh4 = hash(cellID.x * 2.3 + cellID.y * 7.7 + 4.4);
            // only ~25% of cells get a 135° trace (different hash band from 45°)
            if (dh3 > 0.75) {
              float mask135 = 1.0 - diagDist2 / lineW135;
              // parametric pos along 135° diagonal: t goes 0→1 bottom-right to top-left
              float t135 = (cellFrac.y + (1.0 - cellFrac.x)) * 0.5;
              float packetSpeed135 = 0.28 + dh3 * 0.52;
              float packetPhase135 = hash(cellID.x * 1.9 + cellID.y * 8.3 + 2.7);
              float packetPos135 = fract(u_time * packetSpeed135 + packetPhase135);
              float packet135 = step(abs(t135 - packetPos135), 0.045) * 3.0;

              vec3 traceCol135 = mix(
                vec3(0.0, 0.65, 1.0),   // sky blue
                vec3(0.75, 0.15, 1.0),  // violet
                dh4
              );
              col += traceCol135 * mask135 * (0.10 + packet135 * 0.48);
              bright += mask135 * (0.06 + packet135 * 0.30);
            }
          }
        }

        // ── nodes at grid corners (integer gridUV positions) ───────────
        {
          // dist to nearest grid corner in cell-frac space
          vec2 nearCorner = floor(cellFrac + 0.5);  // round() unavailable in GLSL ES 1.0
          vec2 toCorner   = cellFrac - nearCorner;
          float distCorner = max(abs(toCorner.x / cellW), abs(toCorner.y / cellH));

          // node size: small sharp square
          float nodeSize = 0.008;
          if (distCorner < nodeSize) {
            vec2 cornerID = cellID + nearCorner;
            float nh = hash(cornerID.x * 3.7 + cornerID.y * 11.3);
            float nh2 = hash(cornerID.x * 7.1 + cornerID.y * 4.9 + 3.3);

            // pulse: sharp blink
            float blinkSpeed = 1.0 + nh * 2.5;
            float blink = step(0.5, fract(u_time * blinkSpeed + nh2 * 6.28));
            // some nodes are always on, some blink
            float alwaysOn = step(0.4, nh);
            float onOff = max(alwaysOn, blink * step(0.6, nh));

            vec3 nodeCol = mix(
              vec3(0.0, 1.0, 0.6),    // green node
              vec3(0.0, 0.85, 1.0),   // cyan node
              nh2
            );
            col += nodeCol * onOff * 0.85;
            bright += onOff * 0.6;
          }
        }

        // ── scanlines ─────────────────────────────────────────────────
        float scanline = 0.88 + 0.12 * step(0.5, fract(gl_FragCoord.y * 0.5));
        col *= scanline;

        // ── vignette ──────────────────────────────────────────────────
        float vig = 1.0 - 0.55 * pow(length(uv - 0.5) * 1.6, 2.0);
        col *= vig;

        // ── subtle overall brightness pulse ───────────────────────────
        float globalPulse = 0.92 + 0.08 * sin(u_time * 0.4);
        col *= globalPulse;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function compileShader(type: number, src: string) {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      return s;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const aPosLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uRes  = gl.getUniformLocation(prog, "u_res");

    let lastTime = 0;
    function render(now: number) {
      if (!gl || !canvas) return;
      // cap to ~40 fps to stay light
      if (now - lastTime < 25) { animId = requestAnimationFrame(render); return; }
      lastTime = now;
      gl.uniform1f(uTime, now / 1000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      animId = requestAnimationFrame(render);
    }
    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef]);
}

/* ─── Main InfoPage component ────────────────────────────────────────────── */
export default function InfoPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCircuitCanvas(canvasRef);

  return (
    <div
      className="min-h-screen bg-[#0c0e12] text-slate-200"
      style={{ fontFamily: "'Space Grotesk', ui-sans-serif, sans-serif" }}
    >
      {/* ── HERO — full screen ─────────────────────────────────────────── */}
      <section className="relative w-full overflow-hidden" style={{ height: "100vh", minHeight: 520 }}>
        {/* WebGL canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: "block" }}
        />

        {/* Gradient overlay */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(12,14,18,0.20) 0%, rgba(12,14,18,0.10) 40%, rgba(12,14,18,0.75) 78%, rgba(12,14,18,1) 100%)",
          }}
        />

        {/* Hero content */}
        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center px-6">
          {/* Icon */}
          <div
            className="mb-6"
            style={{
              filter: "drop-shadow(0 0 18px rgba(0,220,140,0.7))",
              animation: "float 4s ease-in-out infinite",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              className="w-16 h-16"
              fill="none"
              stroke="url(#iconGrad)"
              strokeWidth="1.6"
              strokeLinecap="square"
              strokeLinejoin="miter"
            >
              <defs>
                <linearGradient id="iconGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#00e589" />
                  <stop offset="100%" stopColor="#00cfff" />
                </linearGradient>
              </defs>
              <polyline points="2,20 9,7 13,13 16,9 22,20" />
              <polyline points="14.3,11 16,9 17.7,11.4" />
            </svg>
          </div>

          <h1
            className="text-4xl md:text-6xl font-bold mb-4 tracking-tight font-mono"
            style={{
              background: "linear-gradient(135deg, #e2e8f0 0%, #00e589 45%, #00cfff 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              letterSpacing: "-0.02em",
            }}
          >
            SFC Agentic Control Plane
          </h1>

          <p
            className="text-base md:text-lg text-slate-400 max-w-5xl mx-auto mb-10 leading-relaxed font-mono whitespace-nowrap"
            style={{ textShadow: "0 2px 12px rgba(0,0,0,0.9)" }}
          >
            Industrial edge connectivity ×{" "}
            <span className="text-[#00e589] font-semibold whitespace-nowrap">Amazon Bedrock AgentCore</span>{" "}
            × <span className="text-[#00cfff] font-semibold whitespace-nowrap">AWS IoT</span>
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/"
              className="btn btn-primary px-7 py-2.5 text-sm font-bold rounded-none font-mono tracking-wider uppercase"
              style={{
                boxShadow: "0 0 20px rgba(0,229,137,0.35), inset 0 0 0 1px rgba(0,229,137,0.4)",
                background: "rgba(0,229,137,0.12)",
                border: "1px solid rgba(0,229,137,0.5)",
                color: "#00e589",
              }}
            >
              ▶ Open Control Plane
            </Link>
            <a
              href="https://github.com/aws-samples/sample-sfc-agentic-control-plane"
              target="_blank"
              rel="noreferrer"
              className="px-7 py-2.5 text-sm font-bold rounded-none font-mono tracking-wider uppercase"
              style={{
                boxShadow: "0 0 16px rgba(0,207,255,0.25), inset 0 0 0 1px rgba(0,207,255,0.3)",
                background: "rgba(0,207,255,0.08)",
                border: "1px solid rgba(0,207,255,0.4)",
                color: "#00cfff",
              }}
            >
              ⌥ GitHub ↗
            </a>
          </div>
        </div>
      </section>

      {/* Keyframe styles */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50%       { transform: translateY(-8px); }
        }
      `}</style>
    </div>
  );
}
