import { HNSWLive } from "@/components/HNSWLive";
import { StarField } from "@/components/StarField";

export default function Page() {
  return (
    <>
      <StarField density={40} />
      <div className="relative h-screen w-screen overflow-hidden">
        <HNSWLive />
      </div>
    </>
  );
}
