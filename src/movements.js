export const MOVEMENT_CATEGORIES = {
  lift: "Lift",
  force: "Force",
  gym: "Gym",
  engine: "Engine",
  core: "Core",
  functional: "Fonctionnel",
};

const categoryByMethod = {load: "lift", force: "force", reps: "gym", distance: "engine"};

export const movementCategory = movement => movement.category ?? categoryByMethod[movement.measurement_method];
