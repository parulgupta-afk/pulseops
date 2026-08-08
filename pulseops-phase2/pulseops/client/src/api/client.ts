import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export const api = axios.create({ baseURL: `${API_URL}/api` });

// Attach the JWT to every request once the user's logged in.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("pulseops_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// A 401 means the token is missing/expired — bounce back to login.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("pulseops_token");
      localStorage.removeItem("pulseops_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);
