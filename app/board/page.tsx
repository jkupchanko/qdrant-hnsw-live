import { HNSWLive } from "@/components/HNSWLive";
import { StarField } from "@/components/StarField";

/**
 * The second display.
 *
 * Screen one is the pipeline, which is watched. This is the board beside it:
 * cluster detail and the competitive comparison, which are read. Nothing here
 * rotates or animates away, so a visitor can take as long as they like.
 */
export default function BoardPage() {
  return (
    <>
      <StarField density={40} />
      <div className="relative h-screen w-screen overflow-hidden">
        <HNSWLive mode="board" />
      </div>
    </>
  );
}
