import React, { useEffect, useRef, useState } from 'react';
import { Canvas, Image as FabricImage, Text as FabricText, Rect, TEvent } from 'fabric';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { buildApiUrl } from '@/config';
import { 
  Crop, 
  Type, 
  Image as ImageIcon, 
  RotateCw, 
  FlipHorizontal, 
  FlipVertical,
  Save,
  X,
  Undo,
  Redo,
  Palette,
  Move,
  Square,
  Circle,
  Download
} from 'lucide-react';

// Fabric v6 ESM usage: use named classes (Canvas, Image, Text) instead of fabric namespace

interface ImageEditorProps {
  imageUrl: string;
  brandData?: {
    primaryColor: string;
    secondaryColor: string;
    fontFamily: string;
  };
  onSave: (editedImageDataUrl: string) => void;
  onCancel: () => void;
}

interface TextElement {
  id: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  fontWeight: string;
  x: number;
  y: number;
}

interface LogoElement {
  id: string;
  url: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

const ImageEditor: React.FC<ImageEditorProps> = ({ 
  imageUrl, 
  brandData, 
  onSave, 
  onCancel 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | 'text' | 'logo' | 'crop'>('select');
  const [textElements, setTextElements] = useState<TextElement[]>([]);
  const [logoElements, setLogoElements] = useState<LogoElement[]>([]);
  const [selectedText, setSelectedText] = useState<TextElement | null>(null);
  const [selectedLogo, setSelectedLogo] = useState<LogoElement | null>(null);
  const [textInput, setTextInput] = useState('');
  const [fontSize, setFontSize] = useState(24);
  const [textColor, setTextColor] = useState(brandData?.primaryColor || '#000000');
  const [fontWeight, setFontWeight] = useState('normal');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '1:1' | '4:5' | '9:16'>('16:9');
  const [isSaving, setIsSaving] = useState(false);
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');
  const [backgroundColor, setBackgroundColor] = useState<string>(brandData?.primaryColor || '#000000');
  const [showSafeZones, setShowSafeZones] = useState<boolean>(true);
  const [lockBackground, setLockBackground] = useState<boolean>(true);

  // Keep references to background and main image for layout
  const backgroundRef = useRef<Rect | null>(null);
  const mainImageRef = useRef<FabricImage | null>(null);
  const safeZonesRef = useRef<Rect[]>([]);

  // Initialize Fabric.js canvas and load image via backend proxy to avoid CORS
  useEffect(() => {
    if (!canvasRef.current) return;

    const init = async () => {
      const canvas = new Canvas(canvasRef.current as HTMLCanvasElement, {
        width: 800,
        height: 600,
        backgroundColor: '#ffffff',
      });
      fabricRef.current = canvas;

      // Use backend proxy to avoid CORS tainting
      const proxiedUrl = buildApiUrl(`/api/files/view-external?url=${encodeURIComponent(imageUrl)}`);

      try {
        // Add background rect first (letterbox)
        const bg = new Rect({
          left: 0,
          top: 0,
          width: canvas.getWidth() || 800,
          height: canvas.getHeight() || 600,
          fill: backgroundColor,
          selectable: false,
          evented: false,
          excludeFromExport: false,
        });
        backgroundRef.current = bg;
        canvas.add(bg);

        const img = await FabricImage.fromURL(proxiedUrl, { crossOrigin: 'anonymous' });
        mainImageRef.current = img;
        positionMainImage(canvas, img, fitMode);
        img.set({ selectable: !lockBackground, evented: !lockBackground });
        canvas.add(img);
        canvas.renderAll();

        // Optional: enable object selection by default
        canvas.selection = true;
        if (showSafeZones) drawSafeZones(canvas);
      } catch (e) {
        console.error('Failed to load image into editor:', e);
      }
    };

    init();

    return () => {
      if (fabricRef.current) {
        fabricRef.current.dispose();
        fabricRef.current = null;
      }
    };
  }, [imageUrl]);

  // Handle canvas clicks for adding text
  const handleCanvasClick = (e: TEvent) => {
    if (activeTool === 'text' && fabricRef.current) {
      const pointer = fabricRef.current.getPointer(e.e);
      addText(pointer.x, pointer.y);
    }
  };

  // Helpers to position the main image
  const positionMainImage = (canvas: Canvas, img: FabricImage, mode: 'fit' | 'fill') => {
    const cw = canvas.getWidth() || 800;
    const ch = canvas.getHeight() || 600;
    const iw = (img.width || 1);
    const ih = (img.height || 1);
    const scaleFit = Math.min(cw / iw, ch / ih);
    const scaleFill = Math.max(cw / iw, ch / ih);
    const scale = mode === 'fit' ? scaleFit : scaleFill;
    img.scale(scale);
    const sw = iw * (img.scaleX || 1);
    const sh = ih * (img.scaleY || 1);
    img.set({ left: (cw - sw) / 2, top: (ch - sh) / 2 });
  };

  // Safe zones
  const SAFE_MARGIN = 0.08; // 8%
  const drawSafeZones = (canvas: Canvas) => {
    const cw = canvas.getWidth() || 800;
    const ch = canvas.getHeight() || 600;
    const left = cw * SAFE_MARGIN;
    const top = ch * SAFE_MARGIN;
    const w = cw * (1 - SAFE_MARGIN * 2);
    const h = ch * (1 - SAFE_MARGIN * 2);
    const border = new Rect({
      left,
      top,
      width: w,
      height: h,
      stroke: 'rgba(255,255,255,0.4)',
      strokeWidth: 2,
      fill: 'rgba(0,0,0,0)',
      selectable: false,
      evented: false,
      excludeFromExport: true,
    });
    canvas.add(border);
    safeZonesRef.current = [border];
  };
  const clearSafeZones = (canvas: Canvas) => {
    safeZonesRef.current.forEach(r => canvas.remove(r));
    safeZonesRef.current = [];
  };

  // Add text to canvas
  const addText = (x: number, y: number) => {
    if (!fabricRef.current || !textInput.trim()) return;

    const text = new FabricText(textInput, {
      left: x,
      top: y,
      fontFamily: brandData?.fontFamily || 'Arial',
      fontSize: fontSize,
      fill: textColor,
      fontWeight: fontWeight,
      selectable: true,
      editable: true
    });

    fabricRef.current.add(text);
    fabricRef.current.setActiveObject(text);
    fabricRef.current.renderAll();

    const newTextElement: TextElement = {
      id: Date.now().toString(),
      text: textInput,
      fontFamily: brandData?.fontFamily || 'Arial',
      fontSize: fontSize,
      color: textColor,
      fontWeight: fontWeight,
      x: x,
      y: y
    };

    setTextElements([...textElements, newTextElement]);
    setTextInput('');
  };

  // Add logo to canvas
  const addLogo = (logoUrl: string) => {
    if (!fabricRef.current) return;

    const load = async () => {
      try {
        // If remote URL, route through backend proxy
        const isRemote = logoUrl.startsWith('http://') || logoUrl.startsWith('https://');
        const src = isRemote ? buildApiUrl(`/api/files/view-external?url=${encodeURIComponent(logoUrl)}`) : logoUrl;
        const img = await FabricImage.fromURL(src, { crossOrigin: 'anonymous' });
        img.scale(0.3);
        const cw = fabricRef.current!.getWidth() || 800;
        const ch = fabricRef.current!.getHeight() || 600;
        const iw = (img.width || 0) * (img.scaleX || 1);
        const ih = (img.height || 0) * (img.scaleY || 1);
        img.set({ left: (cw - iw) / 2, top: (ch - ih) / 2 });
        fabricRef.current!.add(img);
        fabricRef.current!.renderAll();

        const newLogoElement: LogoElement = {
          id: Date.now().toString(),
          url: logoUrl,
          x: img.left || 0,
          y: img.top || 0,
          scaleX: img.scaleX || 1,
          scaleY: img.scaleY || 1
        };
        setLogoElements((prev) => [...prev, newLogoElement]);
      } catch (e) {
        console.error('Failed to load logo:', e);
      }
    };
    load();
  };

  // Quick placement helper
  const placeActiveTo = (pos: 'tl' | 'tr' | 'bl' | 'br' | 'c') => {
    if (!fabricRef.current) return;
    const obj = fabricRef.current.getActiveObject();
    if (!obj) return;
    const cw = fabricRef.current.getWidth() || 800;
    const ch = fabricRef.current.getHeight() || 600;
    const ow = obj.getScaledWidth();
    const oh = obj.getScaledHeight();
    const pad = 24;
    const newPos: any = {};
    switch (pos) {
      case 'tl': newPos.left = pad; newPos.top = pad; break;
      case 'tr': newPos.left = cw - ow - pad; newPos.top = pad; break;
      case 'bl': newPos.left = pad; newPos.top = ch - oh - pad; break;
      case 'br': newPos.left = cw - ow - pad; newPos.top = ch - oh - pad; break;
      case 'c': newPos.left = (cw - ow) / 2; newPos.top = (ch - oh) / 2; break;
    }
    obj.set(newPos);
    fabricRef.current.renderAll();
  };

  // Resize canvas to specific aspect ratio
  const resizeCanvas = (ratio: '16:9' | '1:1' | '4:5' | '9:16') => {
    if (!fabricRef.current) return;

    const canvas = fabricRef.current;
    let newWidth = 800;
    let newHeight = 600;

    switch (ratio) {
      case '16:9':
        newWidth = 800;
        newHeight = 450;
        break;
      case '1:1':
        newWidth = 600;
        newHeight = 600;
        break;
      case '4:5':
        newWidth = 600;
        newHeight = 750;
        break;
      case '9:16':
        newWidth = 450;
        newHeight = 800;
        break;
    }

    canvas.setDimensions({ width: newWidth, height: newHeight });
    if (backgroundRef.current) {
      backgroundRef.current.set({ width: newWidth, height: newHeight, fill: backgroundColor });
    }
    if (mainImageRef.current) {
      positionMainImage(canvas, mainImageRef.current, fitMode);
      mainImageRef.current.set({ selectable: !lockBackground, evented: !lockBackground });
    }
    clearSafeZones(canvas);
    if (showSafeZones) {
      drawSafeZones(canvas);
    }
    canvas.renderAll();
    setAspectRatio(ratio);
  };

  // Save edited image
  const handleSave = async () => {
    if (!fabricRef.current) return;
    
    setIsSaving(true);
    try {
      const dataUrl = fabricRef.current.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: 1
      });
      onSave(dataUrl);
    } catch (error) {
      console.error('Error saving image:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Download edited image
  const handleDownload = () => {
    if (!fabricRef.current) return;
    
    const dataUrl = fabricRef.current.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 1
    });
    
    const link = document.createElement('a');
    link.download = 'edited-image.png';
    link.href = dataUrl;
    link.click();
  };

  return (
    <div className="flex h-full">
      {/* Main Canvas Area */}
      <div className="flex-1 bg-gray-100 p-4">
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <canvas ref={canvasRef} onMouseDownCapture={(e) => {
            // Bridge DOM event to fabric event for text placement
            if (!fabricRef.current) return;
            const pointer = fabricRef.current.getPointer(e.nativeEvent as any);
            if (activeTool === 'text') {
              addText(pointer.x, pointer.y);
            }
          }} />
        </div>
      </div>

      {/* Toolbar */}
      <div className="w-80 bg-gray-900 border-l border-gray-600 p-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-medium">Image Editor</h3>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
              onClick={handleDownload}
              title="Download"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
              onClick={handleSave}
              disabled={isSaving}
              title="Save"
            >
              {isSaving ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                <Save className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
              onClick={onCancel}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Tool Selection */}
        <div className="space-y-4">
          <div>
            <Label className="text-white text-sm font-medium mb-2 block">Canvas</Label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <Select value={fitMode} onValueChange={(v: any) => {
                setFitMode(v);
                if (fabricRef.current && mainImageRef.current) {
                  positionMainImage(fabricRef.current, mainImageRef.current, v);
                  fabricRef.current.renderAll();
                }
              }}>
                <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                  <SelectValue placeholder="Fit Mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">Fit (letterbox)</SelectItem>
                  <SelectItem value="fill">Fill (crop)</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Input type="color" value={backgroundColor} onChange={(e) => {
                  setBackgroundColor(e.target.value);
                  if (backgroundRef.current && fabricRef.current) {
                    backgroundRef.current.set('fill', e.target.value);
                    fabricRef.current.renderAll();
                  }
                }} className="h-10" />
                <span className="text-white text-xs">Bg</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-white mb-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showSafeZones} onChange={(e) => {
                  setShowSafeZones(e.target.checked);
                  if (!fabricRef.current) return;
                  if (e.target.checked) drawSafeZones(fabricRef.current);
                  else clearSafeZones(fabricRef.current);
                  fabricRef.current.renderAll();
                }} /> Safe margins
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={lockBackground} onChange={(e) => {
                  setLockBackground(e.target.checked);
                  if (mainImageRef.current && fabricRef.current) {
                    mainImageRef.current.set({ selectable: !e.target.checked, evented: !e.target.checked });
                    fabricRef.current.renderAll();
                  }
                }} /> Lock image
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={activeTool === 'text' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTool('text')}
                className="text-xs"
              >
                <Type className="h-3 w-3 mr-1" />
                Text
              </Button>
              <Button
                variant={activeTool === 'logo' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTool('logo')}
                className="text-xs"
              >
                <ImageIcon className="h-3 w-3 mr-1" />
                Logo
              </Button>
            </div>
          </div>

          {/* Aspect Ratio Selection */}
          <div>
            <Label className="text-white text-sm font-medium mb-2 block">
              Aspect Ratio
            </Label>
            <Select value={aspectRatio} onValueChange={(value: any) => resizeCanvas(value)}>
              <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                <SelectItem value="1:1">1:1 (Square)</SelectItem>
                <SelectItem value="4:5">4:5 (Portrait)</SelectItem>
                <SelectItem value="9:16">9:16 (Story)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Text Tool Panel */}
          {activeTool === 'text' && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Button size="sm" className="text-xs" onClick={() => {
                  // headline preset
                  setTextInput('Headline');
                  setFontSize(48);
                  setFontWeight('700');
                  setTextColor(brandData?.primaryColor || '#ffffff');
                  addText((fabricRef.current?.getWidth() || 800) / 2, (fabricRef.current?.getHeight() || 600) * 0.15);
                }}>Headline</Button>
                <Button size="sm" variant="outline" className="text-xs" onClick={() => {
                  setTextInput('Subheadline');
                  setFontSize(28);
                  setFontWeight('500');
                  setTextColor(brandData?.secondaryColor || '#ffffff');
                  addText((fabricRef.current?.getWidth() || 800) / 2, (fabricRef.current?.getHeight() || 600) * 0.28);
                }}>Subhead</Button>
                <Button size="sm" variant="outline" className="text-xs" onClick={() => {
                  setTextInput('Call to Action');
                  setFontSize(24);
                  setFontWeight('700');
                  setTextColor('#ffffff');
                  addText((fabricRef.current?.getWidth() || 800) / 2, (fabricRef.current?.getHeight() || 600) * 0.85);
                }}>CTA</Button>
              </div>
              <div>
                <Label className="text-white text-sm font-medium mb-2 block">
                  Add Text
                </Label>
                <Input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Enter text..."
                  className="bg-gray-800 border-gray-600 text-white"
                />
              </div>

              <div>
                <Label className="text-white text-sm font-medium mb-2 block">
                  Font Size
                </Label>
                <Slider
                  value={[fontSize]}
                  onValueChange={(value) => setFontSize(value[0])}
                  min={12}
                  max={72}
                  step={1}
                  className="w-full"
                />
                <span className="text-white text-xs">{fontSize}px</span>
              </div>

              <div>
                <Label className="text-white text-sm font-medium mb-2 block">
                  Text Color
                </Label>
                <Input
                  type="color"
                  value={textColor}
                  onChange={(e) => setTextColor(e.target.value)}
                  className="h-10"
                />
              </div>

              <div>
                <Label className="text-white text-sm font-medium mb-2 block">
                  Font Weight
                </Label>
                <Select value={fontWeight} onValueChange={setFontWeight}>
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="bold">Bold</SelectItem>
                    <SelectItem value="100">Thin</SelectItem>
                    <SelectItem value="300">Light</SelectItem>
                    <SelectItem value="500">Medium</SelectItem>
                    <SelectItem value="700">Bold</SelectItem>
                    <SelectItem value="900">Black</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={() => addText(400, 300)}
                disabled={!textInput.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              >
                Add Text to Center
              </Button>
            </div>
          )}

          {/* Logo Tool Panel */}
          {activeTool === 'logo' && (
            <div className="space-y-3">
              <div>
                <Label className="text-white text-sm font-medium mb-2 block">
                  Add Logo
                </Label>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const url = URL.createObjectURL(file);
                      addLogo(url);
                    }
                  }}
                  className="bg-gray-800 border-gray-600 text-white"
                />
              </div>

              {brandData && (
                <div>
                  <Label className="text-white text-sm font-medium mb-2 block">Quick Placement</Label>
                  <div className="grid grid-cols-5 gap-1 mb-2">
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('tl')}>TL</Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('tr')}>TR</Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('c')}>C</Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('bl')}>BL</Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('br')}>BR</Button>
                  </div>
                  <Label className="text-white text-sm font-medium mb-2 block">Brand Logos</Label>
                  <div className="space-y-2">
                    <Button variant="outline" size="sm" onClick={() => addLogo('/api/brand/logo')} className="w-full text-white border-gray-600 hover:bg-gray-700">Use Primary Logo</Button>
                    <Button variant="outline" size="sm" onClick={() => addLogo('/api/brand/secondary-logo')} className="w-full text-white border-gray-600 hover:bg-gray-700">Use Secondary Logo</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Transform Tools */}
          <div>
            <Label className="text-white text-sm font-medium mb-2 block">
              Transform
            </Label>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (fabricRef.current) {
                    const activeObject = fabricRef.current.getActiveObject();
                    if (activeObject) {
                      activeObject.rotate((activeObject.angle || 0) + 90);
                      fabricRef.current.renderAll();
                    }
                  }
                }}
                className="text-white border-gray-600 hover:bg-gray-700"
              >
                <RotateCw className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (fabricRef.current) {
                    const activeObject = fabricRef.current.getActiveObject();
                    if (activeObject) {
                      activeObject.flipX = !activeObject.flipX;
                      fabricRef.current.renderAll();
                    }
                  }
                }}
                className="text-white border-gray-600 hover:bg-gray-700"
              >
                <FlipHorizontal className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (fabricRef.current) {
                    const activeObject = fabricRef.current.getActiveObject();
                    if (activeObject) {
                      activeObject.flipY = !activeObject.flipY;
                      fabricRef.current.renderAll();
                    }
                  }
                }}
                className="text-white border-gray-600 hover:bg-gray-700"
              >
                <FlipVertical className="h-3 w-3" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('c')}>Center</Button>
              <Button size="sm" variant="outline" className="text-xs" onClick={() => placeActiveTo('br')}>Bottom Right</Button>
            </div>
          </div>

          {/* Instructions */}
          <div className="mt-4 p-3 bg-gray-800 rounded-md">
            <p className="text-white text-xs">
              <strong>Instructions:</strong><br />
              • Click "Text" tool, then click on canvas to add text<br />
              • Use "Logo" tool to upload and place logos<br />
              • Select objects to move, resize, or transform<br />
              • Use aspect ratio presets for different formats
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditor;
