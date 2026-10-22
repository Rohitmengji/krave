"use client";

import React, { useEffect } from "react";
import { X, Palette, Check, Sparkles } from "lucide-react";
import { BRAND_THEME_PRESETS } from "@/data/zomatoReconstructedData";
import { BrandThemePreset } from "@/types/krave";

interface BrandThemeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: BrandThemePreset;
  onSelectPreset: (preset: BrandThemePreset) => void;
  onUpdateCustomBrand: (updates: Partial<BrandThemePreset>) => void;
  isDark: boolean;
}

export function BrandThemeModal({
  isOpen,
  onClose,
  currentTheme,
  onSelectPreset,
  onUpdateCustomBrand,
  isDark,
}: BrandThemeModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Brand and Theme Studio"
      data-testid="brand-studio-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4"
    >
      <div
        className={`w-full max-w-2xl rounded-3xl border shadow-2xl overflow-hidden ${
          isDark
            ? "bg-[#0E131D] border-white/15 text-white"
            : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        <div className="p-5 border-b border-current/10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
              style={{ backgroundColor: currentTheme.primaryHex }}
            >
              <Palette className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-black text-lg">Live Brand & Theme Studio</h2>
              <p className="text-xs opacity-65">
                Customize the brand identity, membership tier, and color palette
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-label="Close Brand Studio"
            onClick={onClose}
            data-testid="close-brand-studio"
            className="p-2 rounded-xl hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Theme Presets */}
          <div>
            <label className="block text-xs font-extrabold uppercase tracking-wider opacity-60 mb-2.5">
              Select Rebrand Theme Preset
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BRAND_THEME_PRESETS.map((preset) => {
                const selected = preset.id === currentTheme.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onSelectPreset(preset)}
                    data-testid={`theme-preset-${preset.id}`}
                    className={`p-3.5 rounded-2xl border text-left transition flex items-center justify-between ${
                      selected
                        ? "border-emerald-400 bg-white/10"
                        : isDark
                        ? "border-white/10 bg-[#141A26] hover:border-white/25"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-white shadow"
                        style={{ backgroundColor: preset.primaryHex }}
                      >
                        {preset.brandName.slice(0, 1)}
                      </span>
                      <div>
                        <div className="text-xs font-black">{preset.name}</div>
                        <div className="text-[11px] opacity-65">
                          Brand: {preset.brandName} • {preset.membershipName}
                        </div>
                      </div>
                    </div>
                    {selected && (
                      <Check
                        className="w-4 h-4 shrink-0"
                        style={{ color: preset.primaryHex }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live Brand Identity Customizer */}
          <div
            className={`p-4 rounded-2xl border space-y-3 ${
              isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
            }`}
          >
            <div className="text-xs font-extrabold uppercase tracking-wider opacity-60 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Customize Live Brand Name, Tagline & Accent Hex</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold mb-1 opacity-70">
                  Brand Name
                </label>
                <input
                  type="text"
                  value={currentTheme.brandName}
                  onChange={(e) =>
                    onUpdateCustomBrand({ brandName: e.target.value })
                  }
                  data-testid="custom-brand-name-input"
                  className={`w-full p-2.5 rounded-xl border text-xs font-bold ${
                    isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                  }`}
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold mb-1 opacity-70">
                  VIP Membership Tier
                </label>
                <input
                  type="text"
                  value={currentTheme.membershipName}
                  onChange={(e) =>
                    onUpdateCustomBrand({ membershipName: e.target.value })
                  }
                  className={`w-full p-2.5 rounded-xl border text-xs font-bold ${
                    isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                  }`}
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold mb-1 opacity-70">
                  Primary Accent Color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={currentTheme.primaryHex}
                    onChange={(e) =>
                      onUpdateCustomBrand({ primaryHex: e.target.value })
                    }
                    className="w-10 h-9 rounded-lg cursor-pointer bg-transparent"
                  />
                  <input
                    type="text"
                    value={currentTheme.primaryHex}
                    onChange={(e) =>
                      onUpdateCustomBrand({ primaryHex: e.target.value })
                    }
                    className={`w-full p-2.5 rounded-xl border text-xs font-mono ${
                      isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                    }`}
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold mb-1 opacity-70">
                Brand Tagline
              </label>
              <input
                type="text"
                value={currentTheme.tagline}
                onChange={(e) =>
                  onUpdateCustomBrand({ tagline: e.target.value })
                }
                className={`w-full p-2.5 rounded-xl border text-xs ${
                  isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                }`}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
