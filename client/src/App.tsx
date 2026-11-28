import { useEffect, useState } from "react";
import { api } from "./lib/api";

export default function App() {
   const [status, setStatus] = useState("Checking the API...");

   useEffect(() => {
      api.get("/health")
         .then((res) =>
            setStatus(
               `API is ${res.data.status}: ${res.data.books} books in the database`,
            ),
         )
         .catch(() => setStatus("Could not reach the API"));
   }, []);

   return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100">
         <div className="rounded-xl bg-white p-8 shadow-lg">
            <h1 className="text-3xl font-bold text-emerald-700">Bookstore</h1>
            <p className="mt-2 text-stone-600">{status}</p>
         </div>
      </div>
   );
}
