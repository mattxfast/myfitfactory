export const MOVEMENT_CATEGORIES = {
  lift: "Lift",
  force: "Force",
  gym: "Gym",
  engine: "Engine",
  core: "Core",
  functional: "Fonctionnel",
};

const categoryByMethod = {load: "lift", force: "force", reps: "gym", distance: "engine", reps_time: "gym"};

export const movementCategory = movement => movement.category ?? categoryByMethod[movement.measurement_method];
export const validMeasurementMethod = method => Object.hasOwn(categoryByMethod, method);
export const prMeasuresTime = record => record.fixed_kind === "distance" || record.fixed_kind === "reps";
