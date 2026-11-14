import { createFileRoute } from "@tanstack/react-router";
import { TrailBrakingTrainer } from "@/components/trail-braking/TrailBrakingTrainer";

export const Route = createFileRoute("/trail-braking")({ component: TrailBrakingTrainer });
