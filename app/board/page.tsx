import { HNSWLive } from "@/components/HNSWLive";
import { StarField } from "@/components/StarField";

/**
 * The second display.
 *
 * Screen one loops the story. This is the board beside it: cluster detail and
 * the competitive comparison, which are read rather than watched, so nothing
 * here rotates away while somebody is halfway through it.
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
