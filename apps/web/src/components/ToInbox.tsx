import { Navigate, useLocation } from 'react-router-dom';

/**
 * Sorted is called Inbox now. Its links carry the arrangement, window and folder in the query
 * string, so the redirect keeps it: an old bookmark should land on the same folder, not the top.
 */
export function ToInbox() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/inbox', search }} replace />;
}
