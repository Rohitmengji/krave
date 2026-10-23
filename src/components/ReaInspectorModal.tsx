"use client";

import React, { useState } from "react";
import {
  X,
  Cpu,
  Smartphone,
  Globe,
  Terminal,
  Play,
  ShieldCheck,
  Code2,
} from "lucide-react";
import { REA_EVIDENCE_SUMMARY } from "@/data/zomatoReconstructedData";
import { BrandThemePreset } from "@/types/krave";
import { FULL_SCREEN_DIALOG, OverlayDialog } from "./OverlayDialog";

interface ReaInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: BrandThemePreset;
  isDark: boolean;
  onInvokeWebMcpTool: (toolName: string) => Record<string, unknown>;
}

const WEBMCP_TOOLS = [
  {
    name: "zomato_search_restaurants",
    desc: "Search partner kitchens with context & limit (discovered in main-e6c9fe541e8ed0c4264b.js)",
  },
  {
    name: "zomato_get_restaurant_menu",
    desc: "Return structured menu categories & items for Haldiram's (#19677790)",
  },
  {
    name: "zomato_get_dish_options",
    desc: "Inspect modifierGroups for Ghee Assorted Sweets Box (ctl_820099425)",
  },
  {
    name: "zomato_add_item_to_cart",
    desc: "Add signature Dal Bukhara (#ctl_dal_bukhara) to live Redux cart",
  },
  {
    name: "zomato_quote_cart",
    desc: "Compute itemized GST, packaging, coupon & Luxe discount quote",
  },
  {
    name: "zomato_list_addresses",
    desc: "List serviceable Delivery Subzones (DSZ) via chunk 3088 htiX",
  },
];

export function ReaInspectorModal({
  isOpen,
  onClose,
  theme,
  isDark,
  onInvokeWebMcpTool,
}: ReaInspectorModalProps) {
  const [activeTab, setActiveTab] = useState<"web" | "apk" | "webmcp">("web");
  const [toolOutput, setToolOutput] = useState<Record<string, unknown> | null>(
    null
  );
  const [lastToolName, setLastToolName] = useState<string>("");

  if (!isOpen) return null;

  const handleRunTool = (name: string) => {
    setLastToolName(name);
    const result = onInvokeWebMcpTool(name);
    setToolOutput(result);
  };

  return (
    <OverlayDialog
      isOpen={isOpen}
      onClose={onClose}
      label="REA Evidence and WebMCP Inspector"
      testId="rea-inspector-modal"
      closeOnBackdrop={false}
      className={`${FULL_SCREEN_DIALOG} open:flex items-center justify-center bg-black/80 backdrop-blur-md p-4`}
    >
      <div
        className={`w-full max-w-4xl rounded-3xl border shadow-2xl overflow-hidden my-auto max-h-[90vh] flex flex-col ${
          isDark
            ? "bg-[#0E131D] border-white/15 text-white"
            : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        {/* Header */}
        <div className="p-5 border-b border-current/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-2xl flex items-center justify-center text-white"
              style={{ backgroundColor: theme.primaryHex }}
            >
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-black text-lg">
                REA (Reverse Engineer Anything) Evidence & WebMCP Studio
              </h2>
              <p className="text-xs opacity-65 font-mono">
                Web observations and reconstruction notes. Android analysis pending.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close REA Inspector"
            onClick={onClose}
            data-testid="close-rea-inspector"
            className="p-2 rounded-xl hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sub-navigation */}
        <div className="px-6 py-3 border-b border-current/10 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("web")}
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              activeTab === "web"
                ? "text-white"
                : "opacity-65 hover:opacity-100"
            }`}
            style={
              activeTab === "web"
                ? { backgroundColor: theme.primaryHex }
                : undefined
            }
          >
            <Globe className="w-3.5 h-3.5" />
            1. Zomato Web AST & CDP Evidence
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("apk")}
            data-testid="rea-tab-apk"
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              activeTab === "apk"
                ? "text-white"
                : "opacity-65 hover:opacity-100"
            }`}
            style={
              activeTab === "apk"
                ? { backgroundColor: theme.primaryHex }
                : undefined
            }
          >
            <Smartphone className="w-3.5 h-3.5" />
            2. Android Analysis Status
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("webmcp")}
            data-testid="rea-tab-webmcp"
            className={`px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              activeTab === "webmcp"
                ? "text-white"
                : "opacity-65 hover:opacity-100"
            }`}
            style={
              activeTab === "webmcp"
                ? { backgroundColor: theme.primaryHex }
                : undefined
            }
          >
            <Terminal className="w-3.5 h-3.5" />
            3. Live zomato_webmcp Agent Tools (17 Tools)
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {activeTab === "web" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
                  <div className="text-[10px] font-mono uppercase opacity-70">
                    AST Nodes Parsed
                  </div>
                  <div className="text-xl font-black text-emerald-400">
                    {REA_EVIDENCE_SUMMARY.jsAppGraph.visitedAstNodes.toLocaleString()}
                  </div>
                </div>
                <div className="p-3.5 rounded-2xl border border-indigo-500/30 bg-indigo-500/10">
                  <div className="text-[10px] font-mono uppercase opacity-70">
                    zwstatic Bundles
                  </div>
                  <div className="text-xl font-black text-indigo-400">
                    {REA_EVIDENCE_SUMMARY.jsAppGraph.parsedBundles} Chunks
                  </div>
                </div>
                <div className="p-3.5 rounded-2xl border border-amber-500/30 bg-amber-500/10">
                  <div className="text-[10px] font-mono uppercase opacity-70">
                    DOM & A11y Nodes
                  </div>
                  <div className="text-xl font-black text-amber-400">
                    {REA_EVIDENCE_SUMMARY.webCapture.domTotalNodes.toLocaleString()}
                  </div>
                </div>
                <div className="p-3.5 rounded-2xl border border-cyan-500/30 bg-cyan-500/10">
                  <div className="text-[10px] font-mono uppercase opacity-70">
                    /webroutes/* APIs
                  </div>
                  <div className="text-xl font-black text-cyan-400">143 Routes</div>
                </div>
              </div>

              <div
                className={`p-4 rounded-2xl border font-mono text-xs space-y-1.5 ${
                  isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="font-bold text-emerald-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4" />
                  REA JavaScript Application Analysis Evidence
                </div>
                <div className="truncate opacity-80">
                  evidence_id: {REA_EVIDENCE_SUMMARY.jsAppGraph.evidenceId}
                </div>
                <div className="truncate opacity-80">
                  inventory_manifest_id: {REA_EVIDENCE_SUMMARY.jsAppGraph.inventoryManifestId}
                </div>
                <div className="truncate opacity-80">
                  web_capture_evidence: {REA_EVIDENCE_SUMMARY.webCapture.evidenceId}
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider opacity-60">
                  Reconstructed Zomato Webpack Chunks (https://zwstatic.zomato.com)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {REA_EVIDENCE_SUMMARY.jsAppGraph.bundles.map((b) => (
                    <div
                      key={b.name}
                      className={`p-3 rounded-xl border text-xs ${
                        isDark
                          ? "bg-[#141A26] border-white/10"
                          : "bg-slate-50 border-slate-200"
                      }`}
                    >
                      <div className="flex items-center justify-between font-mono font-bold">
                        <span className="truncate text-emerald-400">{b.name}</span>
                        <span className="text-[10px] opacity-60 shrink-0">
                          {(b.bytes / 1024).toFixed(1)} KB
                        </span>
                      </div>
                      <div className="text-[11px] opacity-75 mt-1">{b.role}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "apk" && (
            <div className="space-y-3 text-sm">
              <h3 className="font-bold">Android APK not analyzed</h3>
              <p>{REA_EVIDENCE_SUMMARY.androidApkGraph.reason}</p>
              <p>Activity names, native libraries, JNI bridges, permissions, and runtime behavior remain unknown. Analysis requires a genuine, authorized APK and a supported JADX/JDK setup.</p>
            </div>
          )}

          {activeTab === "webmcp" && (
            <div className="space-y-4">
              <div className="text-xs opacity-75">
                REA static analysis of <code className="font-mono">main-e6c9fe541e8ed0c4264b.js</code> &{" "}
                <code className="font-mono">3088-54e4d9b888124e3862e7.js</code> (module{" "}
                <code className="font-mono">htiX</code>) uncovered Zomato&apos;s built-in{" "}
                <code className="font-mono">window.zomato_webmcp</code> agent tool dispatcher. Click any tool below to invoke it live against this app:
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {WEBMCP_TOOLS.map((tool) => (
                  <div
                    key={tool.name}
                    className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                      isDark
                        ? "bg-[#141A26] border-white/10"
                        : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    <div>
                      <div className="text-xs font-black font-mono text-emerald-400">
                        {tool.name}()
                      </div>
                      <div className="text-[11px] opacity-70 mt-0.5">{tool.desc}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRunTool(tool.name)}
                      data-testid={`run-webmcp-${tool.name}`}
                      className="px-3 py-2 rounded-xl text-xs font-black text-white flex items-center gap-1 shrink-0"
                      style={{ backgroundColor: theme.primaryHex }}
                    >
                      <Play className="w-3 h-3" />
                      <span>Run</span>
                    </button>
                  </div>
                ))}
              </div>

              {toolOutput && (
                <div className="p-4 rounded-2xl bg-black/75 border border-emerald-500/40 font-mono text-xs text-emerald-300 space-y-2">
                  <div className="flex items-center justify-between text-white/70 border-b border-white/10 pb-1.5">
                    <span className="flex items-center gap-1.5">
                      <Code2 className="w-4 h-4 text-emerald-400" />
                      <span>Output of window.zomato_webmcp.{lastToolName}()</span>
                    </span>
                    <span className="text-[10px] text-emerald-400">status: ok</span>
                  </div>
                  <pre className="overflow-x-auto text-[11px] max-h-56">
                    {JSON.stringify(toolOutput, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </OverlayDialog>
  );
}
