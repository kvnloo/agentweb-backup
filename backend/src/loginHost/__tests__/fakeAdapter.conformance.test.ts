import { createFakeAdapter, newScript } from "../adapters/fakeAdapter";
import { describeAdapterConformance } from "./adapterConformance";

describeAdapterConformance("fake (paste_code)", () => createFakeAdapter(newScript(), { ceremony: "paste_code" }));
describeAdapterConformance("fake (device_code)", () => createFakeAdapter(newScript(), { ceremony: "device_code" }));
