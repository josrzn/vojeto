import { TimetableService, type Request } from "./timetableService.js";

/**
 * The timetable, off the main thread.
 *
 * All the substance is in TimetableService; this is the message loop. Unpacking
 * a six-megabyte JSON and running RAPTOR over 28,000 trips are both long enough
 * to drop frames, and the whole point of moving the budget and the home station
 * into controls is that they respond while you are still dragging them.
 */
const service = new TimetableService();

self.onmessage = async (event: MessageEvent<Request>) => {
  const response = await service.handle(event.data);
  self.postMessage(response);
};
