export function Watermark() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-0"
      aria-hidden="true"
    >
      <div className="flex flex-col gap-0 leading-none">
        <span className="text-4xl text-gray-100 p-0 m-0 leading-none">瞬写</span>
        <span className="text-5xl font-bold text-gray-100 p-0 m-0 leading-none">IPTRADE</span>
      </div>
    </div>
  );
}
