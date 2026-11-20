import React, { createContext, useContext } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { PhoneFrame } from "@/components/snap-cn/phone-frame";
import { LaptopFrame } from "@/components/snap-cn/laptop-frame";
import { WordCaptions } from "@/components/snap-cn/word-captions";
import cut from "./cut.json";

export const FPS = 30;
export const TOTAL = Math.ceil(cut.total * FPS);
const SANS = loadFont().fontFamily, MONO = loadMono().fontFamily;
const GREEN = "#14f195", RED = "#ff5a3c", INK = "#0b0c0b", DIM = "#8f938b";
const ADDRESS = "5RPLUJsvTDjPzwk6eB9169ixMk1mvydvD2Nwy9hzxm6z";
const POST = "Mint opens Friday. Only trust posts with the green mark.";

type Word = [number, number, string];
const WORDS = cut.words as Word[];
const BEATS = Object.fromEntries((cut.timing as [string, number, number][]).map(([name, begin, end]) => [name, { begin, end }]));

// Each scene asks when a word is spoken instead of carrying hand-timed numbers.
const Beat = createContext({ begin: 0, end: 0 });
function useAt() {
  const beat = useContext(Beat);
  return (word: string, nth = 0) => {
    const found = WORDS.filter(w => w[0] >= beat.begin && w[0] < beat.end && w[2].toLowerCase().startsWith(word.toLowerCase()))[nth];
    if (!found) throw new Error(`"${word}" is not spoken in this beat`);
    return Math.round((found[0] - beat.begin) * FPS);
  };
}

function usePop(at: number) {
  const frame = useCurrentFrame();
  return spring({ frame: frame - at, fps: FPS, config: { damping: 16, stiffness: 140 } });
}
const Pop: React.FC<{ at?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ at = 0, style, children }) => {
  const t = usePop(at);
  return <div style={{ opacity: Math.min(1, t * 1.4), transform: `translateY(${(1 - t) * 40}px) scale(${0.94 + 0.06 * t})`, ...style }}>{children}</div>;
};
/** Shows its children only between two frames, fading at both ends. */
const Span: React.FC<{ from?: number; to?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ from = 0, to = 1e9, style, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [from, from + 6, to - 6, to], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return opacity ? <div style={{ position: "absolute", inset: 0, opacity, ...style }}>{children}</div> : null;
};

const Mark: React.FC<{ size: number; color?: string }> = ({ size, color = GREEN }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round">
    <path d="M4 15v-3a8 8 0 0 1 3.2-6.4" /><path d="M10.4 4.16A8 8 0 0 1 20 12v4" /><path d="M8 19v-7a4 4 0 0 1 8 0v7" /><path d="M12 12v8" />
  </svg>
);
const Label: React.FC<{ color?: string; children: React.ReactNode }> = ({ color = GREEN, children }) => (
  <div style={{ font: `600 26px ${MONO}`, letterSpacing: "0.16em", textTransform: "uppercase", color: DIM, display: "flex", alignItems: "center", gap: 16 }}>
    <span style={{ width: 16, height: 16, background: color }} />{children}
  </div>
);
const Big: React.FC<{ size?: number; color?: string; children: React.ReactNode }> = ({ size = 120, color = "#f1f3ee", children }) => (
  <div style={{ font: `700 ${size}px/1 ${SANS}`, letterSpacing: "-0.04em", color }}>{children}</div>
);

/** A recording, optionally cropped to a rectangle of its 1920x1080 frame. */
const Clip: React.FC<{ src: string; start: number; crop?: [number, number, number, number] }> = ({ src, start, crop }) => {
  const [x, y, w] = crop ?? [0, 0, 1];
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#fff" }}>
      <OffthreadVideo muted src={staticFile(src)} trimBefore={Math.round(start * FPS)}
        style={crop ? { position: "absolute", left: 0, top: 0, width: "100%", maxWidth: "none", transformOrigin: "0 0", transform: `scale(${1920 / w}) translate(${-100 * x / 1920}%, ${-100 * y / 1080}%)` } : { width: "100%", height: "100%", objectFit: "cover" }} />
    </div>
  );
};
/** Plays clips back to back; each entry starts at a frame of the scene. */
const Reel: React.FC<{ parts: { at: number; src: string; start: number; crop?: [number, number, number, number] }[] }> = ({ parts }) => (
  <>{parts.map((part, i) => (
    <Sequence key={i} from={part.at} durationInFrames={(parts[i + 1]?.at ?? 1e6) - part.at} layout="none"><Clip {...part} /></Sequence>
  ))}</>
);

const Box: React.FC<{ x: number; y: number; w: number; h: number; children: React.ReactNode }> = ({ x, y, w, h, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h }}>{children}</div>
);
const Phone: React.FC<{ x: number; y?: number; scale?: number; press?: number; dim?: boolean; children: React.ReactNode }> = ({ x, y = 90, scale = 1.3, press, dim, children }) => {
  const frame = useCurrentFrame();
  const height = 656 * scale, width = 320 * scale;
  const pressed = press === undefined ? 0 : interpolate(frame, [press - 14, press, press + 22, press + 36], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ring = press === undefined ? 0 : interpolate(frame, [press, press + 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Box x={x} y={y} w={width} h={height}>
      <div style={{ position: "absolute", inset: 0, opacity: dim ? 0.6 : 1 }}>
        <PhoneFrame mode="dark" bezelColor="#26272B" scale={scale} floatLoop={false} showDynamicIsland={false} shadow="0 40px 90px rgba(0,0,0,.6)">{children}</PhoneFrame>
      </div>
      {/* The Seeker's sensor is on its side: a thumb comes in from the right edge. */}
      {press !== undefined && <>
        <div style={{ position: "absolute", left: width - 40, top: height * 0.4 - 40, width: 80, height: 80, borderRadius: "50%", border: `5px solid ${GREEN}`, opacity: ring && 1 - ring, transform: `scale(${0.5 + ring * 2.6})` }} />
        <div style={{ position: "absolute", left: width - 18 + (1 - pressed) * 100, top: height * 0.4 - 55, width: 250, height: 110, borderRadius: "55px 40px 40px 55px", background: "linear-gradient(90deg,#f1f3ee,#c9cdc4)", opacity: Math.min(1, pressed * 2), boxShadow: "0 20px 50px rgba(0,0,0,.5)" }}>
          <div style={{ position: "absolute", left: 14, top: 22, width: 62, height: 66, borderRadius: "30px 18px 18px 30px", background: "rgba(255,255,255,.75)" }} />
        </div>
      </>}
    </Box>
  );
};
const Laptop: React.FC<{ x: number; y?: number; scale?: number; children: React.ReactNode }> = ({ x, y = 190, scale = 1.25, children }) => (
  <Box x={x} y={y} w={900 * scale} h={522 * scale}>
    <LaptopFrame mode="light" entrance="rise" scale={scale} floatLoop={false} showNotch={false} screenColor="#fff" shadow="0 40px 90px rgba(0,0,0,.6)">{children}</LaptopFrame>
  </Box>
);
/** The chain between the phone and the laptop. */
const Chain: React.FC<{ x: number; y: number; w: number; at: number; done?: number; label?: string }> = ({ x, y, w, at, done, label = "Solana" }) => {
  const frame = useCurrentFrame();
  const first = interpolate(frame, [at, at + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const second = done === undefined ? 0 : interpolate(frame, [done, done + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chip = usePop(at + 6);
  return (
    <Box x={x} y={y} w={w} h={90}>
      <div style={{ position: "absolute", left: 0, top: 43, height: 5, width: w / 2 * first, background: GREEN }} />
      <div style={{ position: "absolute", left: w / 2, top: 43, height: 5, width: w / 2 * second, background: GREEN }} />
      <div style={{ position: "absolute", left: "50%", top: 0, transform: `translateX(-50%) scale(${chip})`, opacity: chip, padding: "24px 30px", background: INK, border: `4px solid ${GREEN}`, color: GREEN, font: `700 30px/1 ${MONO}`, letterSpacing: "0.16em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</div>
    </Box>
  );
};
const Tag: React.FC<{ at: number; ok?: boolean; children: React.ReactNode }> = ({ at, ok = true, children }) => (
  <Pop at={at} style={{ display: "inline-block", marginTop: 22, padding: "14px 20px", borderRadius: 12, background: ok ? "#e3f6ec" : "#fde8e3", color: ok ? "#0a8a5c" : "#d23f1c", font: "700 26px/1 system-ui, sans-serif" }}>{children}</Pop>
);
const XPost: React.FC<{ mark?: number; children: React.ReactNode }> = ({ mark, children }) => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", color: "#0f1419", padding: "44px 50px", font: "400 30px/1.35 system-ui, sans-serif" }}>
    <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16 }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#141412" }} />
      <div><b>Spek</b> <span style={{ color: "#536471" }}>@Spekthumbprint</span></div>
    </div>
    {children}<br />
    {mark !== undefined && <Tag at={mark}>✓ Approved with a fingerprint</Tag>}
  </div>
);
const PayPage: React.FC<{ address: string; bad?: boolean; mark?: number }> = ({ address, bad, mark }) => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", color: "#0f1419", padding: "44px 50px", font: "400 28px/1.35 system-ui, sans-serif" }}>
    <b style={{ fontSize: 36 }}>Pay @spekthumbprint</b>
    <div style={{ color: "#536471", marginTop: 20 }}>Recipient</div>
    <div style={{ font: `600 26px/1.3 ${MONO}`, color: bad ? "#d23f1c" : "#0f1419", wordBreak: "break-all" }}>{address}</div>
    {bad ? <Tag at={0} ok={false}>Hacker's own wallet</Tag> : mark !== undefined && <Tag at={mark}>✓ Pays only this address</Tag>}
  </div>
);
const PhoneCard: React.FC<{ title: string; mono?: boolean; done?: number; children: React.ReactNode }> = ({ title, mono, done, children }) => (
  <div style={{ position: "absolute", inset: 0, background: "#0f110f", padding: "56px 22px", color: "#e9ece5" }}>
    <div style={{ font: `600 11px ${MONO}`, letterSpacing: "0.16em", textTransform: "uppercase", color: DIM }}>{title}</div>
    <div style={{ marginTop: 14, padding: 14, border: "1px solid #2c2f2b", background: "#181b18", font: mono ? `500 16px/1.4 ${MONO}` : `500 19px/1.3 ${SANS}`, wordBreak: mono ? "break-all" : "normal" }}>{children}</div>
    {done !== undefined && <Pop at={done} style={{ marginTop: 34, textAlign: "center", color: GREEN, font: `700 17px ${MONO}`, letterSpacing: "0.16em" }}><Mark size={90} /><div style={{ marginTop: 10 }}>APPROVED</div></Pop>}
  </div>
);

const Shot: React.FC<{ at?: number; src: string; tag: string; x: number; height?: number }> = ({ at = 0, src, tag, x, height = 760 }) => (
  <Pop at={at} style={{ position: "absolute", left: x, top: (1080 - height) / 2 - 20 }}>
    <div style={{ display: "inline-block", marginBottom: 22, padding: "14px 22px", borderRadius: 10, background: RED, color: INK, font: `700 28px/1 ${MONO}`, letterSpacing: "0.1em" }}>{tag}</div><br />
    <Img src={staticFile(src)} style={{ height, borderRadius: 22, display: "block", boxShadow: "0 40px 90px rgba(0,0,0,.6)" }} />
  </Pop>
);

const scenes: Record<string, React.FC> = {
  sec: () => <Shot src="real-sec.jpg" tag="HACKED · JAN 2024" x={610} />,
  vitalik: () => <Shot src="real-vitalik.jpg" tag="HACKED · $691K STOLEN" x={610} />,
  same: () => <><Shot src="real-sec.jpg" tag="FAKE" x={150} height={540} /><Shot at={8} src="real-vitalik.jpg" tag="FAKE" x={1130} height={540} /></>,
  intro: () => (
    <AbsoluteFill>
      <OffthreadVideo muted src={staticFile("cam5.mp4")} trimBefore={Math.round(cut.intro * FPS)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scale(1.19)", filter: "brightness(1.12) contrast(1.12) saturate(.55)" }} />
      <Pop at={6} style={{ position: "absolute", left: 90, bottom: 190 }}>
        <Big size={84}>Joey Kokinda</Big>
        <div style={{ marginTop: 14, font: `600 30px ${MONO}`, letterSpacing: "0.16em", color: GREEN }}>BOILER BLOCKCHAIN</div>
      </Pop>
    </AbsoluteFill>
  ),
  what: () => {
    const at = useAt();
    return <>
      <Span to={at("a", 2)}><AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 30 }}><Pop><Mark size={200} /></Pop><Pop at={5}><Big size={190}>Thumbprint</Big></Pop></AbsoluteFill></Span>
      <Span from={at("a", 2)}>
        <Sequence from={at("a", 2)} layout="none">
          <Box x={150} y={70} w={600} h={60}><Label>Solana Seeker</Label></Box>
          <Phone x={150} y={150} press={at("fingerprint,") - at("a", 2)}><PhoneCard title="Approve post" done={at("fingerprint,") - at("a", 2) + 14}>{POST}</PhoneCard></Phone>
        </Sequence>
        <Sequence from={at("Every")} layout="none"><Laptop x={850} y={230} scale={1.12}><XPost mark={at("Solana.") - at("Every")}>{POST}</XPost></Laptop></Sequence>
        <Chain x={585} y={440} w={270} at={at("recorded")} done={at("Solana.") - 6} />
      </Span>
    </>;
  },
  setup: () => {
    const at = useAt();
    const steps: [string, number][] = [["Wallet", at("Connect")], ["X account", at("prove")], ["Fingerprint key", at("phone")]];
    return <>
      <Phone x={330}><Clip src="phone-tour-cfr.mp4" start={0} /></Phone>
      <Box x={900} y={250} w={900} h={600}>
        <Label>Set up once</Label>
        {steps.map(([text, when]) => <Pop key={text} at={when} style={{ marginTop: 44, display: "flex", alignItems: "center", gap: 30 }}><span style={{ color: GREEN, font: `700 80px/1 ${SANS}` }}>✓</span><Big size={96}>{text}</Big></Pop>)}
      </Box>
    </>;
  },
  owner: () => {
    const at = useAt();
    const steps: [string, number][] = [["Write.", at("write")], ["Read.", at("Before")], ["Touch.", at("touch")], ["Posted.", at("posts")]];
    return <>
      <Phone x={330} press={at("touch") + 4}><Reel parts={[{ at: 0, src: "live-post-phone.mp4", start: 12.5 }, { at: at("Before"), src: "live-post-phone.mp4", start: 18 }, { at: at("posts"), src: "live-post-phone.mp4", start: 170 }]} /></Phone>
      {steps.map(([text, when], i) => <Span key={text} from={when} to={steps[i + 1]?.[1]}><Box x={1060} y={420} w={800} h={300}><Sequence from={when} layout="none"><Pop><Big size={220} color={i === 3 ? GREEN : undefined}>{text}</Big></Pop></Sequence></Box></Span>)}
    </>;
  },
  follower: () => {
    const at = useAt();
    return <>
      <Pop style={{ position: "absolute", left: 210, top: 50, width: 1500, height: 893, borderRadius: 28, overflow: "hidden", boxShadow: "0 40px 90px rgba(0,0,0,.6)" }}>
        <Reel parts={[{ at: 0, src: "live-post-screen.mp4", start: 209.6, crop: [580, 300, 660, 393] }, { at: at("click"), src: "live-post-screen.mp4", start: 216.5, crop: [580, 300, 660, 393] }, { at: at("proof"), src: "live-post-screen.mp4", start: 227.5, crop: [360, 240, 1200, 715] }]} />
      </Pop>
    </>;
  },
  pay: () => {
    const at = useAt();
    return <>
      <Box x={150} y={70} w={600} h={60}><Label>Payments</Label></Box>
      <Phone x={150} y={150} press={at("touch")}><PhoneCard title="Approve treasury" mono done={at("touch") + 14}>{ADDRESS}</PhoneCard></Phone>
      <Laptop x={850} y={230} scale={1.12}><PayPage address={ADDRESS} mark={at("only")} /></Laptop>
      <Chain x={585} y={440} w={270} at={at("approved")} done={at("payment", 1)} />
    </>;
  },
  hacker: () => {
    const at = useAt();
    return <>
      <Box x={150} y={70} w={900} h={60}><Label color={RED}>The hacker has the password</Label></Box>
      <Phone x={150} y={150}><Reel parts={[{ at: 0, src: "live-hack-phone.mp4", start: 6 }, { at: at("There"), src: "live-hack-phone.mp4", start: 21.5 }]} /></Phone>
      <Sequence from={at("There")} layout="none"><Laptop x={850} y={230} scale={1.12}><Clip src="live-hack-screen.mp4" start={38} crop={[560, 330, 700, 417]} /></Laptop></Sequence>
    </>;
  },
  reject: () => {
    const at = useAt();
    const stamp = usePop(at("reject"));
    return <>
      <Box x={150} y={70} w={900} h={60}><Label color={RED}>Hacker swaps the address</Label></Box>
      <Laptop x={130} y={230} scale={1.05}><PayPage bad address="9hAcK3rWa11etxPq2mVn8sLd4yTb6uZc1oJf5gRe7iKw" /></Laptop>
      <Chain x={1010} y={470} w={260} at={at("Solana")} />
      <Box x={1300} y={440} w={560} h={200}><div style={{ opacity: stamp, transform: `scale(${2 - stamp}) rotate(-6deg)`, display: "inline-block", padding: "20px 30px", border: `8px solid ${RED}`, color: RED, font: `800 72px/1 ${SANS}`, textTransform: "uppercase" }}>Rejected</div></Box>
    </>;
  },
  change: () => {
    const at = useAt();
    const rows: [string, number, number][] = [["Change the address", at("change"), at("fingerprint")], ["Reuse an approval", at("reuse"), at("once")]];
    const end = at("I", 2);
    return <>
      <Span to={end}><Box x={200} y={300} w={1520} h={500}>
        {rows.map(([text, when, fail]) => <Pop key={text} at={when} style={{ display: "flex", alignItems: "center", gap: 40, marginBottom: 70 }}>
          <Sequence from={fail} layout="none"><Pop style={{ color: RED, font: `800 130px/1 ${SANS}` }}>✗</Pop></Sequence>
          <Big size={130}>{text}</Big>
        </Pop>)}
      </Box></Span>
      <Span from={end}><AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}><Sequence from={end} layout="none"><Pop style={{ textAlign: "center" }}><Big size={130}>Has the account.</Big><div style={{ height: 24 }} /><Big size={130} color={RED}>Can't use it.</Big></Pop></Sequence></AbsoluteFill></Span>
    </>;
  },
  kill: () => {
    const at = useAt();
    return <>
      <Box x={150} y={70} w={900} h={60}><Label color={RED}>Kill switch</Label></Box>
      <Phone x={150} y={150} press={at("touch")}><Reel parts={[{ at: 0, src: "live-kill-phone.mp4", start: 17.8 }, { at: at("One"), src: "live-kill-phone.mp4", start: 29.6 }, { at: at("flag"), src: "live-kill-phone.mp4", start: 141 }]} /></Phone>
      <Sequence from={at("flag")} layout="none"><Laptop x={850} y={230} scale={1.12}><Reel parts={[{ at: 0, src: "live-kill-screen.mp4", start: 155, crop: [560, 500, 700, 417] }, { at: at("all") - at("flag"), src: "live-kill-screen.mp4", start: 170, crop: [420, 560, 760, 453] }]} /></Laptop></Sequence>
    </>;
  },
  tech: () => {
    const at = useAt();
    const steps: [string, string, number][] = [["Seeker", "Key never leaves the phone", at("key")], ["Android", "Proves it's real hardware", at("Android")], ["Solana", "Verifies every signature", at("Solana")]];
    return <AbsoluteFill style={{ padding: "0 110px", justifyContent: "center" }}>
      <Label>Why a stolen password isn't enough</Label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 36, marginTop: 60 }}>
        {steps.map(([name, text, when]) => <Pop key={name} at={when} style={{ border: "2px solid #2c2f2b", background: "#141614", padding: "44px 40px", minHeight: 330 }}>
          <div style={{ font: `700 28px ${MONO}`, letterSpacing: "0.16em", color: GREEN, textTransform: "uppercase", marginBottom: 30 }}>{name}</div><Big size={66}>{text}</Big>
        </Pop>)}
      </div>
    </AbsoluteFill>;
  },
  lost: () => {
    const at = useAt();
    return <>
      <Box x={150} y={70} w={900} h={60}><Label>Lost phone</Label></Box>
      <Phone x={330} y={150} dim><PhoneCard title="Old Seeker"><span style={{ color: RED }}>✗ Old key dead</span></PhoneCard></Phone>
      <Chain x={760} y={440} w={400} at={at("wallet")} done={at("new")} label="Wallet" />
      <Sequence from={at("new")} layout="none"><Phone x={1170} y={150}><PhoneCard title="New Seeker" done={8}>New fingerprint key</PhoneCard></Phone></Sequence>
    </>;
  },
  adopt: () => {
    const at = useAt();
    return <AbsoluteFill style={{ padding: "0 140px", justifyContent: "center" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 60 }}>
        <Pop><Label>Today</Label><div style={{ height: 30 }} /><Big size={110}>Chrome extension</Big></Pop>
        <Pop at={at("next")}><Label>Next</Label><div style={{ height: 30 }} /><Big size={110} color={GREEN}>Inside wallets</Big></Pop>
      </div>
    </AbsoluteFill>;
  },
  close: () => {
    const at = useAt();
    return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <Pop><Mark size={150} /></Pop>
      <Pop at={4} style={{ marginTop: 40 }}><Big size={104}>Your password can be stolen.</Big></Pop>
      <Pop at={at("but")} style={{ marginTop: 16 }}><Big size={104} color={GREEN}>Your fingerprint can't.</Big></Pop>
      <Pop at={at("but") + 30} style={{ marginTop: 60, font: `500 30px ${MONO}`, letterSpacing: "0.14em", color: DIM }}>THUMBPRINT.PYRAS.ORG · GITHUB.COM/JOEYKOKINDA/THUMBPRINT</Pop>
    </AbsoluteFill>;
  },
};

const Scene: React.FC<{ name: string; frames: number }> = ({ name, frames }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 6, frames - 6, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const Content = scenes[name];
  return <AbsoluteFill style={{ opacity }}><Beat.Provider value={BEATS[name]}><Content /></Beat.Provider></AbsoluteFill>;
};

export const Demo: React.FC<{ captions?: boolean }> = ({ captions = true }) => (
  <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 50% 0%, #12231b, ${INK} 70%)`, fontFamily: SANS, color: "#f1f3ee" }}>
    <Audio src={staticFile("voice-clean.wav")} />
    <Audio src={staticFile("music.mp3")} loop volume={f => 0.07 * interpolate(f, [0, 45, TOTAL - 90, TOTAL], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
    {(cut.timing as [string, number, number][]).map(([name, begin, end]) => {
      const from = Math.round(begin * FPS), frames = Math.round(end * FPS) - from;
      return <Sequence key={name} from={from} durationInFrames={frames}><Scene name={name} frames={frames} /></Sequence>;
    })}
    {captions && <AbsoluteFill style={{ transform: "translateY(118px)" }}><WordCaptions preset="clean" fontSize={44} accentColor={GREEN} words={WORDS.map(([start, end, text]) => ({ text, startFrame: Math.round(start * FPS), endFrame: Math.round(end * FPS) }))} /></AbsoluteFill>}
  </AbsoluteFill>
);
