// FlintCORE/DMP event handler. One device = one exact TDS metering code + media.
// The sandbox supplies args, info, result, session and log (not Node/browser APIs).
import { fail, handleOnTick, handleOnFetchResp, handleOnService } from "poller";

try {
    switch (args.event) {
        case "OnTick":
            handleOnTick();
            break;
        case "OnFetchResp":
            handleOnFetchResp();
            break;
        case "OnService":
            handleOnService();
            break;
    }
} catch (e) {
    fail(e instanceof Error ? e.message : "Handler error");
}
