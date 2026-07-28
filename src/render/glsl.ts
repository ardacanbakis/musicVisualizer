/**
 * Shared GLSL snippets.
 *
 * Fewer, well-commented shader files beats many thin abstractions — but a
 * handful of things are needed verbatim by every mode, and duplicating them is
 * how two modes end up with subtly different noise or gamma.
 *
 * ---------------------------------------------------------------------------
 * Colour space convention — read this before writing a mode
 * ---------------------------------------------------------------------------
 * Every mode works in LINEAR light and writes linear values into the scene
 * buffer. The stage's final present pass does the one and only sRGB encode.
 *
 * This is not pedantry. Blending, additive accumulation, glow and the
 * luminance limiter are all averaging operations, and averaging sRGB values
 * gives the wrong answer — visibly so where two colours overlap. It also means
 * the limiter measures real luminance rather than a gamma-encoded proxy.
 *
 * Consequence: palette texels are stored as 8-bit sRGB (better precision in
 * the darks than 8-bit linear) and tagged NoColorSpace, so three leaves them
 * alone and the mode decodes explicitly with `ambSrgbToLinear`. Colour uniforms
 * set via `Color.setRGB(r, g, b, SRGBColorSpace)` arrive already linear,
 * because three's colour management converts into the linear working space.
 */

export const COLOR_HELPERS = /* glsl */ `
  vec3 ambSrgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  vec3 ambLinearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
               step(vec3(0.0031308), c));
  }

  float ambLuminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }
`

/** The vertex shader for every full-screen pass. */
export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/**
 * Ashima's simplex noise, 3D. Public domain / MIT.
 * https://github.com/ashima/webgl-noise
 *
 * Used as a stream function rather than sampled directly — see FLOW_HELPERS.
 */
export const SIMPLEX_NOISE = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
               i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
               i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`

/**
 * Divergence-free 2D flow from a stream function.
 *
 * Sampling a noise field directly as a velocity gives a field with sources and
 * sinks: particles pile up in some places and evacuate others, and within a
 * few seconds the screen is half empty. Taking the perpendicular gradient of a
 * scalar stream function instead yields a field that is divergence-free by
 * construction, so density is preserved and the motion reads as swirling
 * rather than draining. That property is the whole reason this looks like
 * anything.
 *
 * Requires SIMPLEX_NOISE.
 */
export const FLOW_HELPERS = /* glsl */ `
  float streamFunction(vec2 p, float t, float scale, float warp) {
    float s = snoise(vec3(p * scale, t));
    // A second octave, turned up by the audio, adds fine detail on top of the
    // large slow structure without changing the overall circulation.
    s += warp * 0.5 * snoise(vec3(p * scale * 2.7 + 13.1, t * 1.6));
    return s;
  }

  vec2 flowVelocity(vec2 p, float t, float scale, float warp) {
    // Central differences. The epsilon is in the same units as p, and must be
    // large enough to survive float precision at the far end of the domain.
    const float e = 0.0015;
    float dx = streamFunction(p + vec2(e, 0.0), t, scale, warp)
             - streamFunction(p - vec2(e, 0.0), t, scale, warp);
    float dy = streamFunction(p + vec2(0.0, e), t, scale, warp)
             - streamFunction(p - vec2(0.0, e), t, scale, warp);
    // Perpendicular gradient => divergence free.
    return vec2(dy, -dx) / (2.0 * e);
  }
`

/** Cheap hash for respawn jitter. Deterministic per particle. */
export const HASH_HELPERS = /* glsl */ `
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
`
