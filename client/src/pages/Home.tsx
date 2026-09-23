import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  Check,
  ChevronDown,
  Circle,
  Clipboard,
  Copy,
  Download,
  Eraser,
  FileImage,
  Hand,
  ImagePlus,
  Minus,
  Move,
  MousePointer2,
  PaintBucket,
  Palette,
  PenLine,
  Redo2,
  RotateCcw,
  Save,
  Scan,
  Scissors,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type ToolId =
  | "select"
  | "pen"
  | "eraser"
  | "fill"
  | "text"
  | "rect"
  | "circle"
  | "line"
  | "arrow"
  | "arrow2"
  | "pan";
type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type StrokeOp = { id: string; type: "stroke"; points: Point[]; color: string; width: number; eraser?: boolean };
type ShapeOp = {
  id: string;
  type: "shape";
  shape: "rect" | "circle" | "line" | "arrow" | "arrow2";
  start: Point;
  end: Point;
  color: string;
  width: number;
};
type TextOp = { id: string; type: "text"; text: string; x: number; y: number; color: string; size: number };
type PasteOp = { id: string; type: "paste"; x: number; y: number; canvas: HTMLCanvasElement; transparent: boolean; scale?: number };
type Op = StrokeOp | ShapeOp | TextOp | PasteOp;

const PALETTE = [
  "#1D2433",
  "#F4C8C9",
  "#F7D6B3",
  "#F6E5A8",
  "#D5E9C8",
  "#BDE5DC",
  "#C8E1F6",
  "#C9CEF2",
  "#DECDF2",
  "#F2CFE3",
  "#E6DED1",
  "#C9D0D7",
  "#7D8796",
  "#FFFFFF",
  "#F3F1EC",
  "#5D6675",
];

const TOOL_META: Record<ToolId, { label: string; hint: string }> = {
  select: { label: "تحديد", hint: "حدد منطقة وانسخها" },
  pen: { label: "قلم", hint: "ارسم بخط حر" },
  eraser: { label: "ممحاة", hint: "امسح ما رسمته" },
  fill: { label: "صبغ", hint: "لوّن منطقة متصلة" },
  text: { label: "نص", hint: "اكتب عربيًا أو أرقامًا" },
  rect: { label: "مربع", hint: "أضف مستطيلًا" },
  circle: { label: "دائرة", hint: "أضف دائرة" },
  line: { label: "خط", hint: "أضف خطًا" },
  arrow: { label: "سهم", hint: "أضف سهمًا" },
  arrow2: { label: "سهمان", hint: "أضف سهمًا برأسين" },
  pan: { label: "تحريك", hint: "حرّك الصفحة" },
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function nearestPaletteColor(r: number, g: number, b: number) {
  let best = PALETTE[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hex of PALETTE) {
    const parsed = hex.slice(1).match(/.{2}/g)?.map((part) => parseInt(part, 16)) ?? [0, 0, 0];
    const distance = (r - parsed[0]) ** 2 + (g - parsed[1]) ** 2 + (b - parsed[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = hex;
    }
  }
  return best;
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ToolButton({ tool, active, onClick, compact = false }: { tool: ToolId; active: boolean; onClick: () => void; compact?: boolean }) {
  const icons: Record<ToolId, React.ReactNode> = {
    select: <MousePointer2 size={19} />,
    pen: <PenLine size={19} />,
    eraser: <Eraser size={19} />,
    fill: <PaintBucket size={19} />,
    text: <Type size={19} />,
    rect: <Square size={19} />,
    circle: <Circle size={19} />,
    line: <Minus size={19} />,
    arrow: <ArrowDownRight size={19} />,
    arrow2: <ArrowDownRight size={19} />,
    pan: <Hand size={19} />,
  };
  return (
    <button className={`tool-button ${active ? "is-active" : ""} ${compact ? "is-compact" : ""}`} onClick={onClick} title={TOOL_META[tool].hint} aria-label={TOOL_META[tool].label}>
      <span className="tool-icon">{icons[tool]}</span>
      <span className="tool-label">{TOOL_META[tool].label}</span>
    </button>
  );
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const clipboardRef = useRef<HTMLCanvasElement | null>(null);
  const pointerMap = useRef(new Map<number, Point>());
  const longPressRef = useRef<number | null>(null);
  const gestureRef = useRef<{ distance: number; zoom: number; center: Point; pan: Point; world: Point } | null>(null);
  const dragRef = useRef<{ kind: "pan" | "text" | "paste" | "resize"; start: Point; original?: TextOp | PasteOp } | null>(null);
  const selectionStartRef = useRef<Point | null>(null);
  const shapeStartRef = useRef<Point | null>(null);

  const [hasImage, setHasImage] = useState(false);
  const [imageName, setImageName] = useState("");
  const [imageSize, setImageSize] = useState({ w: 820, h: 1080 });
  const [view, setView] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState(PALETTE[0]);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [ops, setOps] = useState<Op[]>([]);
  const [history, setHistory] = useState<Op[][]>([]);
  const [redoStack, setRedoStack] = useState<Op[][]>([]);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draftStroke, setDraftStroke] = useState<Point[] | null>(null);
  const [draftShape, setDraftShape] = useState<{ start: Point; end: Point } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPasteId, setSelectedPasteId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [textSize, setTextSize] = useState(28);
  const [pendingText, setPendingText] = useState<Point | null>(null);
  const [pasteTransparent, setPasteTransparent] = useState(true);
  const [status, setStatus] = useState("جاهز للرسم");
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const toast = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus("جاهز للرسم"), 2200);
  }, []);

  const fitView = useCallback((size = imageSize) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const zoom = Math.min((rect.width - 44) / size.w, (rect.height - 44) / size.h);
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? Math.min(1.8, zoom) : 0.42;
    setView({ zoom: safeZoom, pan: { x: (rect.width - size.w * safeZoom) / 2, y: (rect.height - size.h * safeZoom) / 2 } });
  }, [imageSize]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - view.pan.x) / view.zoom, y: (clientY - rect.top - view.pan.y) / view.zoom };
  }, [view]);

  const renderCanvas = useCallback((includeSelection = true) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(view.pan.x, view.pan.y);
    ctx.scale(view.zoom, view.zoom);
    ctx.imageSmoothingEnabled = false;
    if (hasImage && sourceCanvasRef.current) {
      ctx.drawImage(sourceCanvasRef.current, 0, 0);
    } else {
      ctx.fillStyle = "#fffdf9";
      ctx.fillRect(0, 0, imageSize.w, imageSize.h);
      ctx.strokeStyle = "#d8d0c5";
      ctx.lineWidth = 2 / view.zoom;
      ctx.setLineDash([8 / view.zoom, 8 / view.zoom]);
      ctx.strokeRect(1 / view.zoom, 1 / view.zoom, imageSize.w - 2 / view.zoom, imageSize.h - 2 / view.zoom);
      ctx.setLineDash([]);
    }
    for (const op of [...ops, ...(draftStroke ? [{ id: "draft", type: "stroke", points: draftStroke, color, width: strokeWidth, eraser: tool === "eraser" } as StrokeOp] : []), ...(draftShape ? [{ id: "draft-shape", type: "shape", shape: tool as ShapeOp["shape"], start: draftShape.start, end: draftShape.end, color, width: strokeWidth } as ShapeOp] : [])]) {
      ctx.save();
      if (op.type === "stroke") {
        ctx.globalCompositeOperation = op.eraser ? "destination-out" : "source-over";
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        op.points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
        ctx.stroke();
      } else if (op.type === "shape") {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const { start, end } = op;
        if (op.shape === "rect") ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
        if (op.shape === "circle") {
          const radius = Math.hypot(end.x - start.x, end.y - start.y);
          ctx.beginPath();
          ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (op.shape === "line" || op.shape === "arrow" || op.shape === "arrow2") {
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
          if (op.shape === "arrow" || op.shape === "arrow2") {
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const head = Math.max(10, op.width * 4);
            ctx.beginPath();
            ctx.moveTo(end.x, end.y);
            ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(end.x, end.y);
            ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
            if (op.shape === "arrow2") {
              ctx.moveTo(start.x, start.y);
              ctx.lineTo(start.x + head * Math.cos(angle - Math.PI / 6), start.y + head * Math.sin(angle - Math.PI / 6));
              ctx.moveTo(start.x, start.y);
              ctx.lineTo(start.x + head * Math.cos(angle + Math.PI / 6), start.y + head * Math.sin(angle + Math.PI / 6));
            }
            ctx.stroke();
          }
        }
      } else if (op.type === "text") {
        ctx.fillStyle = op.color;
        ctx.font = `700 ${op.size}px "IBM Plex Sans Arabic", sans-serif`;
        ctx.textBaseline = "top";
        ctx.direction = "rtl";
        ctx.fillText(op.text, op.x, op.y);
      } else if (op.type === "paste") {
        const scale = op.scale ?? 1;
        if (!op.transparent) {
          ctx.fillStyle = "#fffdf9";
          ctx.fillRect(op.x, op.y, op.canvas.width * scale, op.canvas.height * scale);
        }
        ctx.drawImage(op.canvas, op.x, op.y, op.canvas.width * scale, op.canvas.height * scale);
      }
      ctx.restore();
    }
    const activeText = ops.find((op): op is TextOp => op.type === "text" && op.id === selectedId);
    const activePaste = ops.find((op): op is PasteOp => op.type === "paste" && op.id === selectedPasteId);
    if (activeText) {
      ctx.save();
      ctx.font = `700 ${activeText.size}px "IBM Plex Sans Arabic", sans-serif`;
      const metrics = ctx.measureText(activeText.text);
      const textWidth = metrics.width + 18;
      const textHeight = activeText.size + 16;
      ctx.strokeStyle = "#2d70e8";
      ctx.lineWidth = 2 / view.zoom;
      ctx.setLineDash([7 / view.zoom, 5 / view.zoom]);
      ctx.strokeRect(activeText.x - textWidth + 4, activeText.y - 5, textWidth, textHeight);
      ctx.setLineDash([]);
      ctx.fillStyle = "#2d70e8";
      ctx.beginPath();
      ctx.arc(activeText.x + 4, activeText.y + textHeight - 5, 6 / view.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (activePaste) {
      ctx.save();
      ctx.strokeStyle = "#2d70e8";
      ctx.lineWidth = 2 / view.zoom;
      ctx.setLineDash([7 / view.zoom, 5 / view.zoom]);
      const pasteScale = activePaste.scale ?? 1;
      ctx.strokeRect(activePaste.x - 5, activePaste.y - 5, activePaste.canvas.width * pasteScale + 10, activePaste.canvas.height * pasteScale + 10);
      ctx.setLineDash([]);
      ctx.fillStyle = "#2d70e8";
      ctx.beginPath();
      ctx.arc(activePaste.x + activePaste.canvas.width * pasteScale + 2, activePaste.y + activePaste.canvas.height * pasteScale + 2, 6 / view.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (includeSelection && selection) {
      ctx.save();
      ctx.strokeStyle = "#2d70e8";
      ctx.lineWidth = 2 / view.zoom;
      ctx.setLineDash([8 / view.zoom, 6 / view.zoom]);
      ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(45,112,232,.11)";
      ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
      ctx.restore();
    }
    ctx.restore();
  }, [color, draftShape, draftStroke, hasImage, imageSize, ops, selectedId, selectedPasteId, selection, strokeWidth, tool, view]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeObserver = new ResizeObserver(() => renderCanvas());
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [renderCanvas]);

  const updateOps = useCallback((next: Op[] | ((previous: Op[]) => Op[])) => {
    setOps((previous) => {
      const resolved = typeof next === "function" ? next(previous) : next;
      setHistory((stack) => [...stack.slice(-24), previous]);
      setRedoStack([]);
      return resolved;
    });
  }, []);

  const loadImage = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast("اختر صورة بصيغة PNG أو JPG");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const ratio = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * ratio));
      const height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const ctx = source.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const nearest = nearestPaletteColor(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
        const rgb = hexToRgb(nearest);
        pixels.data[i] = rgb.r;
        pixels.data[i + 1] = rgb.g;
        pixels.data[i + 2] = rgb.b;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      sourceCanvasRef.current = source;
      setImageSize({ w: width, h: height });
      setHasImage(true);
      setImageName(file.name);
      setOps([]);
      setHistory([]);
      setRedoStack([]);
      setSelection(null);
      setSelectedId(null);
      window.setTimeout(() => fitView({ w: width, h: height }), 40);
      toast("تم تحويل الصورة إلى 16 لونًا");
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadImage(file);
    event.target.value = "";
  };

  const hitElement = (point: Point) => {
    for (let index = ops.length - 1; index >= 0; index -= 1) {
      const op = ops[index];
      if (op.type === "text") {
        const width = Math.max(44, op.text.length * op.size * 0.65);
        const height = op.size + 12;
        if (point.x >= op.x - width && point.x <= op.x + 10 && point.y >= op.y - 8 && point.y <= op.y + height) return { op, resize: point.x > op.x - 18 && point.y > op.y + height - 22 };
      }
      if (op.type === "paste") {
        const scale = op.scale ?? 1;
        const width = op.canvas.width * scale;
        const height = op.canvas.height * scale;
        if (point.x >= op.x - 8 && point.x <= op.x + width + 8 && point.y >= op.y - 8 && point.y <= op.y + height + 8) return { op, resize: point.x > op.x + width - 24 && point.y > op.y + height - 24 };
      }
    }
    return null;
  };

  const pointerCenter = (pointers: Map<number, Point>) => {
    const values = Array.from(pointers.values());
    return { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointerMap.current.set(event.pointerId, point);
    if (pointerMap.current.size === 2) {
      const values = Array.from(pointerMap.current.values());
      const center = pointerCenter(pointerMap.current);
      const world = screenToWorld(center.x, center.y);
      gestureRef.current = { distance: distance(values[0], values[1]), zoom: view.zoom, center, pan: view.pan, world };
      return;
    }
    const world = screenToWorld(event.clientX, event.clientY);
    if (tool === "select" && clipboardRef.current) {
      longPressRef.current = window.setTimeout(() => {
        const clip = clipboardRef.current;
        if (!clip) return;
        const id = makeId();
        updateOps([...ops, { id, type: "paste", x: world.x, y: world.y, canvas: clip, transparent: pasteTransparent, scale: 1 }]);
        setSelectedPasteId(id);
        setSelectedId(null);
        setSelection(null);
        toast("تم اللصق بالضغط المطول");
      }, 650);
    }
    if (tool === "text") {
      const hit = hitElement(world);
      if (hit && hit.op.type === "text") {
        setSelectedId(hit.op.id);
        setSelectedPasteId(null);
        setTextDraft(hit.op.text);
        setTextSize(hit.op.size);
        dragRef.current = { kind: hit.resize ? "resize" : "text", start: world, original: hit.op };
      } else if (hit && hit.op.type === "paste") {
        setSelectedPasteId(hit.op.id);
        setSelectedId(null);
        dragRef.current = { kind: hit.resize ? "resize" : "paste", start: world, original: hit.op };
      } else {
        setSelectedId(null);
        setSelectedPasteId(null);
        setPendingText(world);
        setTextDraft("");
      }
      return;
    }
    if (tool === "select") {
      if (selection && world.x >= selection.x && world.x <= selection.x + selection.w && world.y >= selection.y && world.y <= selection.y + selection.h) {
        setStatus("منطقة محددة — استخدم نسخ أو لصق");
        return;
      }
      const hit = hitElement(world);
      if (hit && hit.op.type === "text") {
        setSelectedId(hit.op.id);
        setSelectedPasteId(null);
        setTextDraft(hit.op.text);
        setTextSize(hit.op.size);
        dragRef.current = { kind: hit.resize ? "resize" : "text", start: world, original: hit.op };
      } else if (hit && hit.op.type === "paste") {
        setSelectedPasteId(hit.op.id);
        setSelectedId(null);
        setSelection(null);
        dragRef.current = { kind: hit.resize ? "resize" : "paste", start: world, original: hit.op };
      } else {
        setSelectedId(null);
        setSelectedPasteId(null);
        setSelection(null);
        selectionStartRef.current = world;
      }
      return;
    }
    if (tool === "pan") {
      dragRef.current = { kind: "pan", start: { x: event.clientX, y: event.clientY } };
      return;
    }
    if (tool === "pen" || tool === "eraser") {
      setDraftStroke([world]);
      return;
    }
    if (["rect", "circle", "line", "arrow", "arrow2"].includes(tool)) {
      shapeStartRef.current = world;
      setDraftShape({ start: world, end: world });
      return;
    }
    if (tool === "fill") {
      floodFill(world);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerMap.current.has(event.pointerId)) return;
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
    pointerMap.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointerMap.current.size >= 2 && gestureRef.current) {
      const values = Array.from(pointerMap.current.values());
      const center = pointerCenter(pointerMap.current);
      const gesture = gestureRef.current;
      const nextZoom = clamp(gesture.zoom * (distance(values[0], values[1]) / gesture.distance), 0.2, 4);
      setView({ zoom: nextZoom, pan: { x: center.x - gesture.world.x * nextZoom - (canvasRef.current?.getBoundingClientRect().left ?? 0), y: center.y - gesture.world.y * nextZoom - (canvasRef.current?.getBoundingClientRect().top ?? 0) } });
      return;
    }
    const world = screenToWorld(event.clientX, event.clientY);
    if (dragRef.current?.kind === "pan") {
      setView((current) => ({ ...current, pan: { x: current.pan.x + event.movementX, y: current.pan.y + event.movementY } }));
      return;
    }
    if (dragRef.current?.kind === "text" || dragRef.current?.kind === "paste" || dragRef.current?.kind === "resize") {
      const drag = dragRef.current;
      if (!drag.original) return;
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      setOps((previous) => previous.map((op) => {
        if (op.id !== drag.original?.id) return op;
        if (op.type === "text" && drag.original.type === "text") {
          if (drag.kind === "resize") return { ...op, size: clamp(drag.original.size + dx * 0.55, 14, 110) };
          return { ...op, x: drag.original.x + dx, y: drag.original.y + dy };
        }
        if (op.type === "paste" && drag.original.type === "paste") {
          const originalScale = drag.original.scale ?? 1;
          if (drag.kind === "resize") return { ...op, scale: clamp(originalScale + dx / Math.max(40, drag.original.canvas.width), 0.2, 5) };
          return { ...op, x: drag.original.x + dx, y: drag.original.y + dy };
        }
        return op;
      }));
      return;
    }
    if (draftStroke) {
      setDraftStroke((points) => (points ? [...points, world] : points));
      return;
    }
    if (shapeStartRef.current) setDraftShape({ start: shapeStartRef.current, end: world });
    if (selectionStartRef.current) setSelection(normalizeRect(selectionStartRef.current, world));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
    pointerMap.current.delete(event.pointerId);
    if (pointerMap.current.size < 2) gestureRef.current = null;
    const world = screenToWorld(event.clientX, event.clientY);
    if (dragRef.current?.kind === "text" || dragRef.current?.kind === "paste" || dragRef.current?.kind === "resize") {
      dragRef.current = null;
      return;
    }
    if (dragRef.current?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    if (draftStroke) {
      if (draftStroke.length > 1) updateOps([...ops, { id: makeId(), type: "stroke", points: draftStroke, color, width: strokeWidth, eraser: tool === "eraser" }]);
      setDraftStroke(null);
      return;
    }
    if (shapeStartRef.current && draftShape) {
      if (distance(shapeStartRef.current, world) > 4) updateOps([...ops, { id: makeId(), type: "shape", shape: tool as ShapeOp["shape"], start: draftShape.start, end: draftShape.end, color, width: strokeWidth }]);
      setDraftShape(null);
      shapeStartRef.current = null;
      return;
    }
    if (selectionStartRef.current) {
      const next = normalizeRect(selectionStartRef.current, world);
      setSelection(next.w > 8 && next.h > 8 ? next : null);
      selectionStartRef.current = null;
    }
  };

  const floodFill = (world: Point) => {
    const source = sourceCanvasRef.current;
    if (!source || world.x < 0 || world.y < 0 || world.x >= source.width || world.y >= source.height) return;
    const ctx = source.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const pixels = ctx.getImageData(0, 0, source.width, source.height);
    const start = (Math.floor(world.y) * source.width + Math.floor(world.x)) * 4;
    const target = [pixels.data[start], pixels.data[start + 1], pixels.data[start + 2], pixels.data[start + 3]];
    const fill = hexToRgb(color);
    if (target[0] === fill.r && target[1] === fill.g && target[2] === fill.b) return;
    const stack: Point[] = [{ x: Math.floor(world.x), y: Math.floor(world.y) }];
    const visited = new Uint8Array(source.width * source.height);
    while (stack.length) {
      const point = stack.pop();
      if (!point || point.x < 0 || point.y < 0 || point.x >= source.width || point.y >= source.height) continue;
      const index = point.y * source.width + point.x;
      if (visited[index]) continue;
      visited[index] = 1;
      const offset = index * 4;
      if (Math.abs(pixels.data[offset] - target[0]) > 16 || Math.abs(pixels.data[offset + 1] - target[1]) > 16 || Math.abs(pixels.data[offset + 2] - target[2]) > 16) continue;
      pixels.data[offset] = fill.r;
      pixels.data[offset + 1] = fill.g;
      pixels.data[offset + 2] = fill.b;
      pixels.data[offset + 3] = 255;
      stack.push({ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 });
    }
    ctx.putImageData(pixels, 0, 0);
    toast("تم صبغ المنطقة");
  };

  const addText = () => {
    const value = textDraft.trim();
    if (!value) return;
    if (selectedId) {
      updateOps(ops.map((op) => op.id === selectedId && op.type === "text" ? { ...op, text: value, size: textSize, color } : op));
    } else if (pendingText) {
      updateOps([...ops, { id: makeId(), type: "text", text: value, x: pendingText.x, y: pendingText.y, color, size: textSize }]);
      setPendingText(null);
    }
    setTextDraft("");
    toast("تمت إضافة النص");
  };

  const copySelection = () => {
    const canvas = canvasRef.current;
    const selectedPaste = ops.find((op): op is PasteOp => op.type === "paste" && op.id === selectedPasteId);
    if (selectedPaste) {
      const copied = document.createElement("canvas");
      copied.width = selectedPaste.canvas.width;
      copied.height = selectedPaste.canvas.height;
      copied.getContext("2d")?.drawImage(selectedPaste.canvas, 0, 0);
      clipboardRef.current = copied;
      toast("تم نسخ العنصر الملصق");
      return;
    }
    if (!canvas || !selection || selection.w < 2 || selection.h < 2) {
      toast("حدد منطقة أولًا");
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const copied = document.createElement("canvas");
    copied.width = Math.max(1, Math.round(selection.w));
    copied.height = Math.max(1, Math.round(selection.h));
    const sourceContext = canvas.getContext("2d");
    const copyContext = copied.getContext("2d");
    if (!sourceContext || !copyContext) return;
    renderCanvas(false);
    const screenX = view.pan.x + selection.x * view.zoom;
    const screenY = view.pan.y + selection.y * view.zoom;
    const data = sourceContext.getImageData(Math.round(screenX * dpr), Math.round(screenY * dpr), Math.round(selection.w * view.zoom * dpr), Math.round(selection.h * view.zoom * dpr));
    const temp = document.createElement("canvas");
    temp.width = data.width;
    temp.height = data.height;
    temp.getContext("2d")?.putImageData(data, 0, 0);
    copyContext.drawImage(temp, 0, 0, copied.width, copied.height);
    clipboardRef.current = copied;
    renderCanvas(true);
    toast("تم نسخ المنطقة");
  };

  const pasteSelection = () => {
    const clip = clipboardRef.current;
    if (!clip) {
      toast("انسخ منطقة أولًا");
      return;
    }
    const position = selection ? { x: selection.x + 18, y: selection.y + 18 } : { x: Math.max(0, imageSize.w / 2 - clip.width / 2), y: Math.max(0, imageSize.h / 2 - clip.height / 2) };
    const id = makeId();
    updateOps([...ops, { id, type: "paste", x: position.x, y: position.y, canvas: clip, transparent: pasteTransparent }]);
    setSelectedPasteId(id);
    setSelectedId(null);
    setSelection(null);
    toast(pasteTransparent ? "تم اللصق بشفافية" : "تم اللصق بدون شفافية");
  };

  const deleteSelected = () => {
    const id = selectedPasteId || selectedId;
    if (id) {
      updateOps(ops.filter((op) => op.id !== id));
      setSelectedPasteId(null);
      setSelectedId(null);
      setTextDraft("");
      toast("تم حذف الإضافة");
      return;
    }
    if (selection) {
      const source = sourceCanvasRef.current;
      const sourceContext = source?.getContext("2d");
      if (source && sourceContext) {
        sourceContext.fillStyle = "#fffdf9";
        sourceContext.fillRect(selection.x, selection.y, selection.w, selection.h);
      }
      setSelection(null);
      toast("تم حذف المنطقة");
    }
  };

  const duplicateSelected = () => {
    const source = ops.find((op) => op.id === (selectedPasteId || selectedId));
    if (!source || (source.type !== "paste" && source.type !== "text")) {
      toast("حدد نصًا أو نسخة أولًا");
      return;
    }
    const clone = source.type === "paste"
      ? { ...source, id: makeId(), x: source.x + 24, y: source.y + 24 }
      : { ...source, id: makeId(), x: source.x + 24, y: source.y + 24 };
    updateOps([...ops, clone]);
    if (clone.type === "paste") {
      setSelectedPasteId(clone.id);
      setSelectedId(null);
    } else {
      setSelectedId(clone.id);
      setSelectedPasteId(null);
    }
    toast("تم تكرار الإضافة");
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setRedoStack((stack) => [...stack, ops]);
    setOps(previous);
    setHistory((stack) => stack.slice(0, -1));
    setSelectedId(null);
    setSelectedPasteId(null);
    toast("تم التراجع");
  };

  const redo = () => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setHistory((stack) => [...stack, ops]);
    setOps(next);
    setRedoStack((stack) => stack.slice(0, -1));
    setSelectedPasteId(null);
    toast("تمت الإعادة");
  };

  const saveImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `${imageName.replace(/\.[^/.]+$/, "") || "math-drawing"}-edited.png`;
    link.href = url;
    link.click();
    toast("تم حفظ الصورة");
  };

  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    setView((current) => {
      const nextZoom = clamp(current.zoom * factor, 0.2, 4);
      return { zoom: nextZoom, pan: { x: center.x - ((center.x - current.pan.x) / current.zoom) * nextZoom, y: center.y - ((center.y - current.pan.y) / current.zoom) * nextZoom } };
    });
  };

  const clearAll = () => {
    updateOps([]);
    setSelection(null);
    setSelectedId(null);
    setSelectedPasteId(null);
    toast("تم مسح التعديلات");
  };

  const activeText = useMemo(() => ops.find((op): op is TextOp => op.type === "text" && op.id === selectedId), [ops, selectedId]);

  return (
    <div className="app-shell" dir="rtl">
      <input ref={fileInputRef} type="file" accept="image/*" className="sr-only" onChange={handleFile} />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Scan size={20} /></div>
          <div>
            <div className="brand-name">رسّام الرياضيات</div>
            <div className="brand-subtitle">ملاحظاتك، أوضح وأسهل</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={() => fileInputRef.current?.click()}><Upload size={17} /><span>رفع صورة</span></button>
          <button className="primary-button" onClick={saveImage}><Save size={17} /><span>حفظ PNG</span></button>
        </div>
      </header>

      <main className="editor-layout">
        <section className="workspace-card">
          <div className="workspace-header">
            <div className="document-chip"><FileImage size={15} /><span>{imageName || "لم تُرفع صورة بعد"}</span></div>
            <div className="workspace-actions">
              <button className="icon-button" onClick={() => zoomBy(1.15)} title="تكبير"><ZoomIn size={17} /></button>
              <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
              <button className="icon-button" onClick={() => zoomBy(0.87)} title="تصغير"><ZoomOut size={17} /></button>
              <button className="icon-button" onClick={() => fitView()} title="ملاءمة"><Move size={17} /></button>
            </div>
          </div>
          <div className="canvas-stage">
            <div className="canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}>
              <div className="canvas-toolbar-group">
                <button className="canvas-tool-button" onClick={undo} disabled={!history.length}><Undo2 size={15} /> تراجع</button>
                <button className="canvas-tool-button" onClick={redo} disabled={!redoStack.length}><Redo2 size={15} /> إعادة</button>
              </div>
              <div className="canvas-toolbar-group canvas-object-actions">
                <button className="canvas-tool-button" onClick={copySelection}><Copy size={15} /> نسخ</button>
                <button className="canvas-tool-button" onClick={pasteSelection}><Clipboard size={15} /> لصق</button>
                <button className="canvas-tool-button" onClick={duplicateSelected} disabled={!selectedId && !selectedPasteId}><Copy size={15} /> تكرار</button>
                <button className="canvas-tool-button delete-tool" onClick={deleteSelected} disabled={!selection && !selectedId && !selectedPasteId}><Trash2 size={15} /> حذف</button>
                <button className="canvas-tool-button paste-mode" onClick={() => setPasteTransparent((value) => !value)}>{pasteTransparent ? "شفاف" : "أبيض"}</button>
              </div>
            </div>
            <canvas ref={canvasRef} className="editor-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
            {(pendingText || activeText) && (
              <input
                className="floating-text-input"
                dir="rtl"
                autoFocus
                value={textDraft}
                placeholder="اكتب هنا…"
                onChange={(event) => setTextDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addText(); } }}
                onBlur={() => { if (textDraft.trim()) addText(); }}
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  top: `${view.pan.y + (activeText?.y ?? pendingText?.y ?? 0) * view.zoom - 8}px`,
                  left: `${view.pan.x + (activeText?.x ?? pendingText?.x ?? 0) * view.zoom - 188}px`,
                  fontSize: `${Math.max(14, textSize * view.zoom)}px`,
                  width: `${Math.max(150, Math.min(310, 190 * view.zoom))}px`,
                }}
              />
            )}
            {!hasImage && (
              <button className="empty-state" onClick={() => fileInputRef.current?.click()}>
                <div className="empty-icon"><ImagePlus size={30} /></div>
                <strong>ارفع صورة مسألة أو رسم</strong>
                <span>سيتم تحويلها تلقائيًا إلى 16 لونًا خفيفًا</span>
                <span className="empty-cta"><Upload size={15} /> اختر صورة من الجوال</span>
              </button>
            )}
            {hasImage && <div className="canvas-badge"><span className="status-dot" /> 16 لونًا</div>}
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-intro">
            <div>
              <div className="eyebrow">أدوات التحرير</div>
              <h1>{TOOL_META[tool].label}</h1>
            </div>
            <div className="status-pill"><span className="status-dot" />{status}</div>
          </div>

          <div className="palette-section">
            <div className="section-label"><span><Palette size={15} /> اللون</span><span className="color-name">{color === "#1D2433" ? "أسود واضح" : "لون فاتح"}</span></div>
            <div className="palette-row">
              <button className="color-swatch current-color" style={{ backgroundColor: color }} onClick={() => setShowColorPicker((value) => !value)} aria-label="فتح قائمة الألوان" />
              <button className={`color-menu-button ${showColorPicker ? "is-open" : ""}`} onClick={() => setShowColorPicker((value) => !value)}><ChevronDown size={15} /> {showColorPicker ? "إخفاء الألوان" : "اختيار لون"}</button>
            </div>
            {showColorPicker && <div className="extra-colors">{PALETTE.map((item) => <button key={item} className={`color-swatch ${color === item ? "is-selected" : ""}`} style={{ backgroundColor: item }} onClick={() => { setColor(item); setShowColorPicker(false); }} />)}</div>}
          </div>

          <div className="tool-grid">
            <ToolButton tool="select" active={tool === "select"} onClick={() => setTool("select")} />
            <ToolButton tool="pen" active={tool === "pen"} onClick={() => setTool("pen")} />
            <ToolButton tool="eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} />
            <ToolButton tool="fill" active={tool === "fill"} onClick={() => setTool("fill")} />
            <ToolButton tool="text" active={tool === "text"} onClick={() => setTool("text")} />
            <ToolButton tool="pan" active={tool === "pan"} onClick={() => setTool("pan")} />
            <button className={`tool-button more-tools ${showMoreTools ? "is-active" : ""}`} onClick={() => setShowMoreTools((value) => !value)}><span className="tool-icon"><Palette size={19} /></span><span className="tool-label">أشكال</span></button>
          </div>
          {showMoreTools && <div className="shape-tools"><ToolButton tool="rect" active={tool === "rect"} onClick={() => setTool("rect")} compact /><ToolButton tool="circle" active={tool === "circle"} onClick={() => setTool("circle")} compact /><ToolButton tool="line" active={tool === "line"} onClick={() => setTool("line")} compact /><ToolButton tool="arrow" active={tool === "arrow"} onClick={() => setTool("arrow")} compact /><ToolButton tool="arrow2" active={tool === "arrow2"} onClick={() => setTool("arrow2")} compact /></div>}

          <div className="slider-section">
            <div className="section-label"><span><PenLine size={15} /> السماكة</span><b>{strokeWidth}px</b></div>
            <input className="range-input" type="range" min="1" max="120" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} />
            <div className="range-hints"><span>دقيق</span><span>عريض</span></div>
          </div>

          <div className="tip-line"><RotateCcw size={14} /> اسحب لتحديد أو تحريك الإضافات • اضغط مطولًا للصق</div>
        </section>
      </main>

      <footer className="mobile-dock"><div className="dock-scroll"><ToolButton tool="select" active={tool === "select"} onClick={() => setTool("select")} compact /><ToolButton tool="pen" active={tool === "pen"} onClick={() => setTool("pen")} compact /><ToolButton tool="eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} compact /><ToolButton tool="text" active={tool === "text"} onClick={() => setTool("text")} compact /><ToolButton tool="fill" active={tool === "fill"} onClick={() => setTool("fill")} compact /><ToolButton tool="rect" active={tool === "rect"} onClick={() => setTool("rect")} compact /><ToolButton tool="circle" active={tool === "circle"} onClick={() => setTool("circle")} compact /><ToolButton tool="arrow" active={tool === "arrow"} onClick={() => setTool("arrow")} compact /><ToolButton tool="arrow2" active={tool === "arrow2"} onClick={() => setTool("arrow2")} compact /><ToolButton tool="pan" active={tool === "pan"} onClick={() => setTool("pan")} compact /><button className="dock-upload" onClick={() => fileInputRef.current?.click()}><Upload size={18} /><span>رفع</span></button></div></footer>
    </div>
  );
}
