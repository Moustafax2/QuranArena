// Shared semantic color tokens so status/severity colors stay consistent
// across the app instead of each component picking its own shade.

export const DANGER_TEXT = "text-red-400 hover:text-red-300";
export const DANGER_SOLID = "bg-red-600 text-white hover:bg-red-500";
export const DANGER_SUBTLE = "border-red-500/30 bg-red-500/10 text-red-300";

export const WARNING_TEXT = "text-amber-400";
export const WARNING_SUBTLE = "border-amber-500/30 bg-amber-500/10 text-amber-300";

export const SUCCESS_TEXT = "text-emerald-400";
export const SUCCESS_SUBTLE = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";

export type Difficulty = "Easy" | "Medium" | "Hard";

export const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  Easy: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  Medium: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  Hard: "text-red-400 bg-red-400/10 border-red-400/20",
};
